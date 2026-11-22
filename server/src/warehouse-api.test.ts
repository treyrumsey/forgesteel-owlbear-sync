import { TEST_ORIGIN, type TestServer, startTestServer } from './test-support.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_VERSION } from './routes/auth.ts';
import type { ServerEvent } from './events.ts';
import { connect as connectSocket } from 'node:net';

let t: TestServer;
let alice: string;
let aliceIpad: string;
let bob: string;
let gm: string;
const events: ServerEvent[] = [];

beforeAll(async () => {
	t = await startTestServer({ bodyLimits: { hero: 64 * 1024 } });
	t.services.events.on(event => events.push(event));
	const room = await t.createRoom();
	gm = room.deviceToken;
	const aliceSeat = await t.join({ code: room.joinCode, newSeatName: 'Alice', deviceLabel: 'Alice laptop' });
	alice = aliceSeat.deviceToken;
	aliceIpad = (await t.join({ code: room.joinCode, seatId: aliceSeat.seat.id, deviceLabel: 'Alice iPad' })).deviceToken;
	bob = (await t.join({ code: room.joinCode, newSeatName: 'Bob' })).deviceToken;
});

afterAll(async () => {
	await t.close();
});

const access = async (deviceToken: string) => (await t.connect(deviceToken)).access_token;

describe('Warehouse API: connection', () => {
	it('reports a version Forge Steel treats as major 1, so it uses POST /connect', async () => {
		const body = await (await fetch(`${t.base}/healthz`)).json();

		expect(body).toEqual({ version: API_VERSION });
		expect(parseInt(API_VERSION.split('.')[0])).toBe(1);
	});

	it('answers the credentialed CORS preflight for /connect from an allowed origin', async () => {
		const response = await fetch(`${t.base}/connect`, {
			method: 'OPTIONS',
			headers: { 'Origin': TEST_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,x-no-retry' }
		});

		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
		expect(response.headers.get('access-control-allow-credentials')).toBe('true');
		expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-no-retry');
	});

	it('refuses CORS to other origins, including forgesteel.net', async () => {
		const preflight = await fetch(`${t.base}/connect`, {
			method: 'OPTIONS',
			headers: { 'Origin': 'https://forgesteel.net', 'Access-Control-Request-Method': 'POST' }
		});
		const health = await fetch(`${t.base}/healthz`, { headers: { Origin: 'https://evil.example' } });
		const allowed = await fetch(`${t.base}/healthz`, { headers: { Origin: TEST_ORIGIN } });

		expect(preflight.status).toBe(403);
		expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
		expect(health.headers.get('access-control-allow-origin')).toBeNull();
		expect(allowed.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
	});

	it('exchanges a device token for tokens, and rejects bad or missing ones like the reference Warehouse', async () => {
		const tokens = await t.connect(alice);
		const invalid = await t.call('/connect', 'nope', { method: 'POST' });
		const missing = await t.call('/connect', null, { method: 'POST' });

		expect(tokens.access_token.split('.')).toHaveLength(3);
		expect(await (await t.call('/me', tokens.access_token)).json()).toMatchObject({ logged_in_as: 'Alice', seat: { name: 'Alice', isGm: false } });
		expect(invalid.status).toBe(401);
		expect(await invalid.json()).toEqual({ message: 'Invalid token' });
		expect(missing.status).toBe(400);
	});

	it('returns 401 "Token has expired" for an expired access token, and refreshes it', async () => {
		const tokens = await t.connect(alice);
		t.clock.now += 16 * 60 * 1000;

		const expired = await t.call('/data/forgesteel-heroes', tokens.access_token);
		const refreshed = await (await t.call('/refresh', tokens.refresh_token, { method: 'POST' })).json();
		const retried = await t.call('/data/forgesteel-heroes', refreshed.access_token);

		expect(expired.status).toBe(401);
		expect(await expired.json()).toEqual({ msg: 'Token has expired' });
		expect(retried.status).toBe(200);
	});

	it('does not accept a refresh token as an access token, or the reverse', async () => {
		const tokens = await t.connect(alice);

		expect((await t.call('/me', tokens.refresh_token)).status).toBe(422);
		expect((await t.call('/refresh', tokens.access_token, { method: 'POST' })).status).toBe(422);
	});

	// Node's HTTP parser accepts this target but URL can't parse it; it used to crash the stub
	it('answers 400 to a malformed request target and keeps serving', async () => {
		const port = Number(new URL(t.base).port);
		const response = await new Promise<string>((resolve, reject) => {
			const socket = connectSocket(port, '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
			let text = '';
			socket.on('data', chunk => text += chunk.toString());
			socket.on('end', () => resolve(text));
			socket.on('error', reject);
		});

		expect(response.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
		expect((await fetch(`${t.base}/healthz`)).status).toBe(200);
	});
});

describe('Warehouse API: data', () => {
	const hero = { id: 'hero-1', name: 'Kalla', folder: 'Party', state: { staminaDamage: 0 } };

	it('stores heroes per seat, lists partials, and stamps a revision on full reads', async () => {
		const laptop = await access(alice);
		const ipad = await access(aliceIpad);

		expect((await t.putHero(laptop, hero)).status).toBe(204);

		expect(await (await t.call('/data/forgesteel-heroes?fields=name,folder', ipad)).json())
			.toEqual({ data: [ { id: 'hero-1', name: 'Kalla', folder: 'Party' } ] });
		expect(await (await t.call('/data/forgesteel-heroes/hero-1', ipad)).json())
			.toEqual({ data: { ...hero, _syncSteel: { rev: 1 } } });
		expect((await t.call('/data/forgesteel-heroes/hero-1', await access(bob))).status).toBe(404);
	});

	it('lets the GM see and edit every hero, but not a player another seat\'s hero', async () => {
		const gmToken = await access(gm);
		const bobToken = await access(bob);
		await t.putHero(bobToken, { id: 'bob-hero', name: 'Rook', state: { staminaDamage: 0 } });

		const gmList = await (await t.call('/data/forgesteel-heroes?fields=name', gmToken)).json();
		const gmEdit = await t.putHero(gmToken, { id: 'bob-hero', name: 'Rook', state: { staminaDamage: 4 } });
		const aliceEdit = await t.putHero(await access(alice), { id: 'bob-hero', name: 'Stolen', state: { staminaDamage: 0 } });
		const bobView = await (await t.call('/data/forgesteel-heroes/bob-hero', bobToken)).json();

		expect(gmList.data.map((h: { id: string }) => h.id)).toEqual(expect.arrayContaining([ 'hero-1', 'bob-hero' ]));
		expect(gmEdit.status).toBe(204);
		expect(aliceEdit.status).toBe(403);
		expect(await aliceEdit.json()).toEqual({ message: 'This hero belongs to another seat in the room' });
		expect(bobView.data.state.staminaDamage).toBe(4);
	});

	it('keeps the revision for an echoed hero and bumps it for a change', async () => {
		const token = await access(bob);
		const rev = async () => (await (await t.call('/data/forgesteel-heroes/hero-2', token)).json()).data._syncSteel.rev;

		await t.putHero(token, { id: 'hero-2', name: 'Vex', state: { staminaDamage: 0 } });
		await t.putHero(token, { state: { staminaDamage: 0 }, name: 'Vex', id: 'hero-2', _syncSteel: { rev: 1 } });
		expect(await rev()).toBe(1);

		await t.putHero(token, { id: 'hero-2', name: 'Vex', state: { staminaDamage: 5 }, _syncSteel: { rev: 1 } });
		expect(await rev()).toBe(2);
	});

	// Forge Steel never sees the new revision after a save, so its second save still carries the stamp it loaded
	it('uses a session\'s own last write as the merge base, but not another session\'s', async () => {
		const laptop = await access(alice);
		const ipad = await access(aliceIpad);
		const put = (token: string, damage: number) => t.putHero(token, { id: 'hero-3', name: 'Ash', state: { staminaDamage: damage }, _syncSteel: { rev: 1 } });
		await put(laptop, 0);

		t.logLines.length = 0;
		await put(laptop, 3);
		await put(laptop, 4);
		await put(ipad, 9);
		const heroLines = t.logLines.filter(line => line.includes('hero hero-3'));

		expect(heroLines[0]).toContain('rev 1 -> 2 (stamp rev 1, session wrote rev 1, base rev 1)');
		expect(heroLines[1]).toContain('rev 2 -> 3 (stamp rev 1, session wrote rev 2, base rev 2)');
		expect(heroLines[1]).not.toContain('WARNING');
		expect(heroLines[2]).toContain('rev 3 -> 4 (stamp rev 1, session wrote rev none, base rev 1) WARNING: stale base (current was rev 3)');
	});

	it('records the session id with each revision', () => {
		const revisions = t.db.prepare('SELECT rev, sid, source FROM hero_revisions WHERE hero_id = ? ORDER BY rev').all('hero-3') as { rev: number, sid: string, source: string }[];

		expect(revisions).toHaveLength(4);
		expect(revisions.every(revision => (revision.source === 'device') && (revision.sid.length > 0))).toBe(true);
		expect(revisions[1].sid).toBe(revisions[2].sid);
		expect(revisions[3].sid).not.toBe(revisions[2].sid);
	});

	it('never reuses revision numbers after a delete, and flags bases from the deleted copy', async () => {
		const token = await access(bob);
		const url = '/data/forgesteel-heroes/hero-4';
		const put = (session: string, damage: number, stampRev?: number) => t.putHero(session, { id: 'hero-4', name: 'Rook', state: { staminaDamage: damage }, ...(stampRev ? { _syncSteel: { rev: stampRev } } : {}) });
		await put(token, 0);
		await put(token, 1);
		const stale = (await (await t.call(url, token)).json()).data._syncSteel.rev;
		expect((await t.call(url, token, { method: 'DELETE' })).status).toBe(204);
		expect((await t.call(url, token)).status).toBe(404);

		t.logLines.length = 0;
		await put(token, 2);
		await put(await access(bob), 9, stale);
		const heroLines = t.logLines.filter(line => line.includes('hero hero-4'));

		expect(stale).toBe(2);
		expect(heroLines[0]).toContain('rev 0 -> 3');
		expect(heroLines[0]).toContain('WARNING: re-creates a deleted hero');
		expect(heroLines[1]).toContain('rev 3 -> 4 (stamp rev 2, session wrote rev none, base rev 2) WARNING: base predates this hero\'s re-creation at rev 3');
	});

	it('raises an event for each committed change, but not for an echo', async () => {
		const token = await access(alice);
		events.length = 0;

		await t.putHero(token, { id: 'hero-5', name: 'Sol', state: { staminaDamage: 0 } });
		await t.putHero(token, { id: 'hero-5', name: 'Sol', state: { staminaDamage: 0 }, _syncSteel: { rev: 1 } });
		await t.call('/data/forgesteel-heroes/hero-5', token, { method: 'DELETE' });

		expect(events.map(event => [ event.type, event.heroId, event.rev ])).toEqual([ [ 'hero.changed', 'hero-5', 1 ], [ 'hero.deleted', 'hero-5', 1 ] ]);
	});

	it('rejects a hero whose id does not match the URL', async () => {
		const response = await t.call('/data/forgesteel-heroes/other', await access(alice), { method: 'PUT', body: JSON.stringify(hero) });

		expect(response.status).toBe(400);
	});

	it('rejects a body over the size limit', async () => {
		const big = { ...hero, notes: 'x'.repeat(70 * 1024) };

		const response = await t.putHero(await access(alice), big);

		expect(response.status).toBe(413);
	});

	it('shares homebrew across the room, but keeps session and hidden sourcebook ids per seat', async () => {
		const bobToken = await access(bob);
		const aliceToken = await access(alice);

		await t.call('/data/forgesteel-homebrew-settings/hb-1', bobToken, { method: 'PUT', body: JSON.stringify({ id: 'hb-1', name: 'Mine' }) });
		await t.call('/data/forgesteel-session', bobToken, { method: 'PUT', body: JSON.stringify({ id: 'session' }) });
		await t.call('/data/forgesteel-hidden-setting-ids', bobToken, { method: 'PUT', body: JSON.stringify([ 'a' ]) });

		expect(await (await t.call('/data/forgesteel-homebrew-settings', aliceToken)).json()).toEqual({ data: [ { id: 'hb-1', name: 'Mine' } ] });
		expect(await (await t.call('/data/forgesteel-session', bobToken)).json()).toEqual({ data: { id: 'session' } });
		expect(await (await t.call('/data/forgesteel-hidden-setting-ids', bobToken)).json()).toEqual({ data: [ 'a' ] });
		expect(await (await t.call('/data/forgesteel-session', aliceToken)).json()).toEqual({ data: null });

		expect((await t.call('/data/forgesteel-homebrew-settings/hb-1', aliceToken, { method: 'DELETE' })).status).toBe(204);
		expect(await (await t.call('/data/forgesteel-homebrew-settings', bobToken)).json()).toEqual({ data: [] });
	});

	it('answers unknown data keys with 404', async () => {
		const response = await t.call('/data/forgesteel-unknown', await access(alice));

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: 'Unknown data key: forgesteel-unknown' });
	});
});
