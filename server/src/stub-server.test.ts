import { STUB_VERSION, createStubServer } from './stub-server.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { connect as connectSocket } from 'node:net';

const ORIGIN = 'http://localhost:5173';

let clock = Date.now();
const logLines: string[] = [];
const server = createStubServer({
	deviceTokens: { 'token-a': 'Alice', 'token-a2': 'Alice', 'token-b': 'Bob' },
	corsOrigins: [ ORIGIN ],
	jwtSecret: 'test-secret',
	now: () => clock,
	maxBodyBytes: 64 * 1024,
	log: line => logLines.push(line)
});
let base = '';

beforeAll(async () => {
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
	clock = Date.now();
});

const connect = async (deviceToken: string) => {
	const response = await fetch(`${base}/connect`, { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}` } });
	return await response.json() as { access_token: string, refresh_token: string };
};

const call = (path: string, token: string, init: RequestInit = {}) => {
	return fetch(`${base}${path}`, {
		...init,
		headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers }
	});
};

describe('stub Warehouse: connection', () => {
	it('reports a version Forge Steel treats as major 1, so it uses POST /connect', async () => {
		const body = await (await fetch(`${base}/healthz`)).json();

		expect(body).toEqual({ version: STUB_VERSION });
		expect(parseInt(STUB_VERSION.split('.')[0])).toBe(1);
	});

	it('answers the credentialed CORS preflight for /connect from an allowed origin', async () => {
		const response = await fetch(`${base}/connect`, {
			method: 'OPTIONS',
			headers: { 'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,x-no-retry' }
		});

		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		expect(response.headers.get('access-control-allow-credentials')).toBe('true');
		expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-no-retry');
	});

	it('refuses CORS to other origins', async () => {
		const preflight = await fetch(`${base}/connect`, {
			method: 'OPTIONS',
			headers: { 'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
		});
		const health = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } });

		expect(preflight.status).toBe(403);
		expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
		expect(health.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('exchanges a device token for tokens, and rejects bad or missing ones like the reference Warehouse', async () => {
		const tokens = await connect('token-a');
		const invalid = await fetch(`${base}/connect`, { method: 'POST', headers: { Authorization: 'Bearer nope' } });
		const missing = await fetch(`${base}/connect`, { method: 'POST' });

		expect(tokens.access_token.split('.')).toHaveLength(3);
		expect(await (await call('/me', tokens.access_token)).json()).toEqual({ logged_in_as: 'Alice' });
		expect(invalid.status).toBe(401);
		expect(await invalid.json()).toEqual({ message: 'Invalid token' });
		expect(missing.status).toBe(400);
	});

	it('returns 401 "Token has expired" for an expired access token, and refreshes it', async () => {
		const tokens = await connect('token-a');
		clock += 16 * 60 * 1000;

		const expired = await call('/data/forgesteel-heroes', tokens.access_token);
		const refreshed = await (await call('/refresh', tokens.refresh_token, { method: 'POST' })).json();
		const retried = await call('/data/forgesteel-heroes', refreshed.access_token);

		expect(expired.status).toBe(401);
		expect(await expired.json()).toEqual({ msg: 'Token has expired' });
		expect(retried.status).toBe(200);
	});

	it('does not accept a refresh token as an access token', async () => {
		const tokens = await connect('token-a');

		expect((await call('/me', tokens.refresh_token)).status).toBe(422);
	});

	// Node's HTTP parser accepts this target but URL can't parse it; it used to crash the process
	it('answers 400 to a malformed request target and keeps serving', async () => {
		const port = (server.address() as AddressInfo).port;
		const response = await new Promise<string>((resolve, reject) => {
			const socket = connectSocket(port, '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
			let text = '';
			socket.on('data', chunk => text += chunk.toString());
			socket.on('end', () => resolve(text));
			socket.on('error', reject);
		});

		expect(response.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
	});
});

describe('stub Warehouse: data', () => {
	const hero = { id: 'hero-1', name: 'Kalla', folder: 'Party', state: { staminaDamage: 0 } };

	it('stores heroes per seat, lists partials, and stamps a revision on full reads', async () => {
		const alice = (await connect('token-a')).access_token;
		const aliceIpad = (await connect('token-a2')).access_token;
		const bob = (await connect('token-b')).access_token;

		expect((await call('/data/forgesteel-heroes/hero-1', alice, { method: 'PUT', body: JSON.stringify(hero) })).status).toBe(204);

		expect(await (await call('/data/forgesteel-heroes?fields=name,folder', aliceIpad)).json())
			.toEqual({ data: [ { id: 'hero-1', name: 'Kalla', folder: 'Party' } ] });
		expect(await (await call('/data/forgesteel-heroes/hero-1', aliceIpad)).json())
			.toEqual({ data: { ...hero, _syncSteel: { rev: 1 } } });
		expect((await call('/data/forgesteel-heroes/hero-1', bob)).status).toBe(404);
	});

	it('keeps the revision for an echoed hero and bumps it for a change', async () => {
		const token = (await connect('token-b')).access_token;
		const put = (body: object) => call('/data/forgesteel-heroes/hero-2', token, { method: 'PUT', body: JSON.stringify(body) });
		const rev = async () => (await (await call('/data/forgesteel-heroes/hero-2', token)).json()).data._syncSteel.rev;

		await put({ id: 'hero-2', name: 'Vex', state: { staminaDamage: 0 } });
		await put({ state: { staminaDamage: 0 }, name: 'Vex', id: 'hero-2', _syncSteel: { rev: 1 } });
		expect(await rev()).toBe(1);

		await put({ id: 'hero-2', name: 'Vex', state: { staminaDamage: 5 }, _syncSteel: { rev: 1 } });
		expect(await rev()).toBe(2);
	});

	// Forge Steel never sees the new revision after a save, so its second save still carries the stamp it loaded
	it('uses a session\'s own last write as the merge base, but not another session\'s', async () => {
		const laptop = (await connect('token-a')).access_token;
		const ipad = (await connect('token-a2')).access_token;
		const put = (token: string, damage: number) => call('/data/forgesteel-heroes/hero-3', token, {
			method: 'PUT',
			body: JSON.stringify({ id: 'hero-3', name: 'Ash', state: { staminaDamage: damage }, _syncSteel: { rev: 1 } })
		});
		await put(laptop, 0);

		logLines.length = 0;
		await put(laptop, 3);
		await put(laptop, 4);
		await put(ipad, 9);
		const heroLines = logLines.filter(line => line.includes('hero hero-3'));

		expect(heroLines[0]).toContain('rev 1 -> 2 (stamp rev 1, session wrote rev 1, base rev 1)');
		expect(heroLines[1]).toContain('rev 2 -> 3 (stamp rev 1, session wrote rev 2, base rev 2)');
		expect(heroLines[1]).not.toContain('WARNING');
		expect(heroLines[2]).toContain('rev 3 -> 4 (stamp rev 1, session wrote rev none, base rev 1) WARNING: stale base (current was rev 3)');
	});

	it('never reuses revision numbers after a delete, and flags bases from the deleted copy', async () => {
		const token = (await connect('token-b')).access_token;
		const url = '/data/forgesteel-heroes/hero-4';
		const put = (damage: number, stampRev?: number) => call(url, token, {
			method: 'PUT',
			body: JSON.stringify({ id: 'hero-4', name: 'Rook', state: { staminaDamage: damage }, ...(stampRev ? { _syncSteel: { rev: stampRev } } : {}) })
		});
		await put(0);
		await put(1);
		const stale = (await (await call(url, token)).json()).data._syncSteel.rev;
		await call(url, token, { method: 'DELETE' });

		logLines.length = 0;
		await put(2);
		const otherSession = (await connect('token-b')).access_token;
		await call(url, otherSession, {
			method: 'PUT',
			body: JSON.stringify({ id: 'hero-4', name: 'Rook', state: { staminaDamage: 9 }, _syncSteel: { rev: stale } })
		});
		const heroLines = logLines.filter(line => line.includes('hero hero-4'));

		expect(stale).toBe(2);
		expect(heroLines[0]).toContain('rev 0 -> 3');
		expect(heroLines[0]).toContain('WARNING: re-creates a deleted hero');
		expect(heroLines[1]).toContain('rev 3 -> 4 (stamp rev 2, session wrote rev none, base rev 2) WARNING: base predates this hero\'s re-creation at rev 3');
	});

	it('rejects a hero whose id does not match the URL', async () => {
		const token = (await connect('token-a')).access_token;

		const response = await call('/data/forgesteel-heroes/other', token, { method: 'PUT', body: JSON.stringify(hero) });

		expect(response.status).toBe(400);
	});

	it('rejects a body over the size limit', async () => {
		const token = (await connect('token-a')).access_token;
		const big = { ...hero, notes: 'x'.repeat(70 * 1024) };

		const response = await call('/data/forgesteel-heroes/hero-1', token, { method: 'PUT', body: JSON.stringify(big) });

		expect(response.status).toBe(413);
	});

	it('stores homebrew, session and hidden sourcebook ids', async () => {
		const token = (await connect('token-b')).access_token;

		await call('/data/forgesteel-homebrew-settings/hb-1', token, { method: 'PUT', body: JSON.stringify({ id: 'hb-1', name: 'Mine' }) });
		await call('/data/forgesteel-session', token, { method: 'PUT', body: JSON.stringify({ id: 'session' }) });
		await call('/data/forgesteel-hidden-setting-ids', token, { method: 'PUT', body: JSON.stringify([ 'a' ]) });

		expect(await (await call('/data/forgesteel-homebrew-settings', token)).json()).toEqual({ data: [ { id: 'hb-1', name: 'Mine' } ] });
		expect(await (await call('/data/forgesteel-session', token)).json()).toEqual({ data: { id: 'session' } });
		expect(await (await call('/data/forgesteel-hidden-setting-ids', token)).json()).toEqual({ data: [ 'a' ] });
	});
});
