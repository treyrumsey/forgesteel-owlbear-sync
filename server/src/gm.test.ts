import { type TestServer, startTestServer } from './test-support.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshotter } from './snapshots.ts';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

let t: TestServer;
let room: Awaited<ReturnType<TestServer['createRoom']>>;
let gm: string;

beforeEach(async () => {
	t = await startTestServer();
	room = await t.createRoom('Thursday group');
	gm = (await t.connect(room.deviceToken)).access_token;
});

afterEach(async () => {
	await t.close();
});

const player = async (name: string) => {
	const joined = await t.join({ code: room.joinCode, newSeatName: name });
	return { seat: joined.seat, deviceToken: joined.deviceToken, access: (await t.connect(joined.deviceToken)).access_token };
};

const exportRoom = async (token: string) => {
	const response = await t.call('/gm/export', token);
	return { response: response, bytes: Buffer.from(await response.arrayBuffer()) };
};

describe('GM endpoints', () => {
	it('are for the GM seat only', async () => {
		const alice = await player('Alice');

		expect((await t.call('/gm/room', alice.access)).status).toBe(403);
		expect((await t.call('/gm/export', alice.access)).status).toBe(403);
	});

	it('list the room\'s seats with their devices and heroes', async () => {
		const alice = await player('Alice');
		await t.putHero(alice.access, { id: 'kalla', name: 'Kalla' });

		const info = await (await t.call('/gm/room', gm)).json();

		expect(info.room).toMatchObject({ name: 'Thursday group', lastExportAt: null });
		expect(info.seats).toMatchObject([
			{ name: 'GM', isGm: true, devices: [ { label: 'GM laptop', current: true } ], heroes: [] },
			{ name: 'Alice', isGm: false, devices: [ { label: 'Phone', current: false } ], heroes: [ { id: 'kalla', name: 'Kalla', rev: 1 } ] }
		]);
	});

	it('rotate the join code without signing out devices that already joined', async () => {
		const alice = await player('Alice');

		const { joinCode } = await (await t.post('/gm/join-code', {}, gm)).json();

		expect((await t.post('/join/lookup', { code: room.joinCode })).status).toBe(404);
		expect((await t.post('/join/lookup', { code: joinCode })).status).toBe(200);
		expect((await t.call('/connect', alice.deviceToken, { method: 'POST' })).status).toBe(200);
	});

	it('rename a seat, refusing a name another seat has', async () => {
		const alice = await player('Alice');
		await player('Bob');

		const renamed = await t.call(`/gm/seats/${alice.seat.id}`, gm, { method: 'PATCH', body: JSON.stringify({ name: 'Alicia' }) });
		const clash = await t.call(`/gm/seats/${alice.seat.id}`, gm, { method: 'PATCH', body: JSON.stringify({ name: 'bob' }) });

		expect(await renamed.json()).toEqual({ id: alice.seat.id, name: 'Alicia', isGm: false });
		expect(clash.status).toBe(409);
	});

	it('list a hero\'s revisions and restore an old one as a new revision', async () => {
		const alice = await player('Alice');
		await t.putHero(alice.access, { id: 'kalla', name: 'Kalla', state: { staminaDamage: 0 } });
		await t.putHero(alice.access, { id: 'kalla', name: 'Kalla', state: { staminaDamage: 30 } });

		const revisions = await (await t.call('/gm/heroes/kalla/revisions', gm)).json();
		const restored = await (await t.post('/gm/heroes/kalla/restore', { rev: 1 }, gm)).json();
		const hero = await (await t.call('/data/forgesteel-heroes/kalla', alice.access)).json();

		expect(revisions.data.map((r: { rev: number, current: boolean }) => [ r.rev, r.current ])).toEqual([ [ 2, true ], [ 1, false ] ]);
		expect(restored).toEqual({ rev: 3, changed: true });
		expect(hero.data).toEqual({ id: 'kalla', name: 'Kalla', state: { staminaDamage: 0 }, _syncSteel: { rev: 3 } });
	});

	it('bring back a deleted hero', async () => {
		const alice = await player('Alice');
		await t.putHero(alice.access, { id: 'kalla', name: 'Kalla' });
		await t.call('/data/forgesteel-heroes/kalla', alice.access, { method: 'DELETE' });

		const deleted = await (await t.call('/gm/heroes/deleted', gm)).json();
		const restored = await (await t.post('/gm/heroes/kalla/restore', {}, gm)).json();
		const list = await (await t.call('/data/forgesteel-heroes?fields=name', alice.access)).json();

		expect(deleted.data).toMatchObject([ { id: 'kalla', name: 'Kalla', seatId: alice.seat.id } ]);
		expect(restored).toEqual({ rev: 2, changed: true });
		expect(list.data).toEqual([ { id: 'kalla', name: 'Kalla' } ]);
	});

	it('keep an audit log of room changes', async () => {
		await player('Alice');
		await t.post('/gm/join-code', {}, gm);

		const audit = await (await t.call('/gm/audit', gm)).json();

		expect(audit.data.map((entry: { action: string }) => entry.action)).toEqual([ 'room.code-rotated', 'device.joined', 'room.created' ]);
	});
});

describe('GM export and import', () => {
	const seedRoom = async () => {
		const alice = await player('Alice');
		await t.putHero(alice.access, { id: 'kalla', name: 'Kalla', state: { staminaDamage: 3 } });
		await t.putHero(alice.access, { id: 'gone', name: 'Gone' });
		await t.call('/data/forgesteel-heroes/gone', alice.access, { method: 'DELETE' });
		await t.putHero(gm, { id: 'npc', name: 'Captain' });
		await t.call('/data/forgesteel-homebrew-settings/hb', alice.access, { method: 'PUT', body: JSON.stringify({ id: 'hb', name: 'House rules' }) });
		await t.call('/data/forgesteel-session', gm, { method: 'PUT', body: JSON.stringify({ id: 'session-1' }) });
		await t.call('/data/forgesteel-hidden-setting-ids', alice.access, { method: 'PUT', body: JSON.stringify([ 'orden' ]) });
		return alice;
	};

	it('download the whole room as gzipped JSON, without secrets', async () => {
		await seedRoom();

		const { response, bytes } = await exportRoom(gm);
		const text = gunzipSync(bytes).toString('utf8');
		const payload = JSON.parse(text);
		const info = await (await t.call('/gm/room', gm)).json();

		expect(response.headers.get('content-type')).toBe('application/gzip');
		expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="sync-steel-thursday-group-\d{4}-\d{2}-\d{2}\.json\.gz"$/);
		expect(payload).toMatchObject({ format: 'sync-steel-room-export', version: 1, room: { name: 'Thursday group' } });
		expect(payload.seats).toMatchObject([ { name: 'GM', isGm: true, session: { id: 'session-1' } }, { name: 'Alice', hiddenSettingIds: [ 'orden' ] } ]);
		expect(payload.heroes.map((h: { id: string, deleted: boolean }) => [ h.id, h.deleted ])).toEqual([ [ 'kalla', false ], [ 'gone', true ], [ 'npc', false ] ]);
		expect(payload.homebrew).toMatchObject([ { id: 'hb', data: { name: 'House rules' } } ]);
		expect(text).not.toContain(room.gmKey);
		expect(text).not.toContain(room.deviceToken);
		expect(info.room.lastExportAt).not.toBeNull();
	});

	it('restore an export into a new room: a dry run changes nothing, then the import recreates everything', async () => {
		await seedRoom();
		const { bytes } = await exportRoom(gm);
		const target = await t.createRoom('Restored');
		const targetGm = (await t.connect(target.deviceToken)).access_token;
		const upload = (dryRun: boolean) => t.call(`/gm/import${dryRun ? '?dryRun=1' : ''}`, targetGm, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/gzip' } });

		const dryRun = await (await upload(true)).json();
		const afterDryRun = await (await t.call('/gm/room', targetGm)).json();
		const imported = await (await upload(false)).json();
		const again = await (await upload(false)).json();

		const expected = {
			seats: { matched: 1, created: 1 },
			seatData: { updated: 2 },
			heroes: { created: 3, updated: 0, unchanged: 0, skipped: 0 },
			homebrew: { created: 1, updated: 0, unchanged: 0, skipped: 0 }
		};
		expect(dryRun).toEqual({ dryRun: true, summary: expected });
		expect(afterDryRun.seats).toHaveLength(1);
		expect(imported).toEqual({ dryRun: false, summary: expected });
		expect(again.summary).toEqual({
			seats: { matched: 2, created: 0 },
			seatData: { updated: 0 },
			heroes: { created: 0, updated: 0, unchanged: 2, skipped: 1 },
			homebrew: { created: 0, updated: 0, unchanged: 1, skipped: 0 }
		});

		const alice = await t.join({ code: target.joinCode, seatId: (await (await t.call('/gm/room', targetGm)).json()).seats[1].id });
		const aliceAccess = (await t.connect(alice.deviceToken)).access_token;
		const kalla = await (await t.call('/data/forgesteel-heroes/kalla', aliceAccess)).json();
		const hidden = await (await t.call('/data/forgesteel-hidden-setting-ids', aliceAccess)).json();
		const deleted = await (await t.call('/gm/heroes/deleted', targetGm)).json();
		expect(alice.seat.name).toBe('Alice');
		expect(kalla.data).toEqual({ id: 'kalla', name: 'Kalla', state: { staminaDamage: 3 }, _syncSteel: { rev: 1 } });
		expect(hidden).toEqual({ data: [ 'orden' ] });
		expect(deleted.data.map((h: { id: string }) => h.id)).toEqual([ 'gone' ]);
	});

	it('reject a file that isn\'t a room export', async () => {
		const response = await t.call('/gm/import', gm, { method: 'POST', body: JSON.stringify({ heroes: [] }) });

		expect(response.status).toBe(400);
		expect((await response.json()).message).toContain('isn\'t a valid Sync Steel room export');
	});
});

describe('GM snapshot restore', () => {
	it('lists the daily snapshots and exports this room from one, ready to import', async () => {
		await t.close();
		const dir = mkdtempSync(join(tmpdir(), 'sync-steel-gm-snapshots-'));
		t = await startTestServer({ snapshotDir: dir });
		room = await t.createRoom('Thursday group');
		gm = (await t.connect(room.deviceToken)).access_token;
		const alice = await player('Alice');
		await t.putHero(alice.access, { id: 'kalla', name: 'Kalla', state: { staminaDamage: 2 } });
		createSnapshotter({ db: t.db, dir: dir, keep: 14, now: () => t.clock.now }).snapshotIfDue();
		await t.putHero(alice.access, { id: 'kalla', name: 'Kalla', state: { staminaDamage: 50 } });

		const list = await (await t.call('/gm/snapshots', gm)).json();
		const missing = await t.call('/gm/snapshots/2020-01-01/export', gm);
		const exported = await t.call('/gm/snapshots/2026-11-22/export', gm);
		const file = Buffer.from(await exported.arrayBuffer());
		const imported = await (await t.call('/gm/import', gm, { method: 'POST', body: file, headers: { 'Content-Type': 'application/gzip' } })).json();
		const kalla = await (await t.call('/data/forgesteel-heroes/kalla', alice.access)).json();

		expect(list).toEqual({ data: [ { date: '2026-11-22' } ] });
		expect(missing.status).toBe(404);
		expect(exported.headers.get('content-disposition')).toContain('sync-steel-thursday-group-2026-11-22-snapshot.json.gz');
		expect(imported.summary.heroes).toEqual({ created: 0, updated: 1, unchanged: 0, skipped: 0 });
		expect(kalla.data.state).toEqual({ staminaDamage: 2 });
	});
});
