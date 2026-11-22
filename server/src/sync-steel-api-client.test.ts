import { SyncSteelApiError, SyncSteelDeviceApi, SyncSteelRoomApi } from '@/sync-steel/api/sync-steel-api';
import { type TestServer, startTestServer } from './test-support.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createSnapshotter } from './snapshots.ts';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The fork's Sync Steel page client, against the real server over HTTP

let t: TestServer | null = null;
let dir: string | null = null;

afterEach(async () => {
	await t?.close();
	t = null;
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = null;
	}
});

const expectApiError = async (promise: Promise<unknown>, status: number, message?: string) => {
	const error = await promise.then(() => null, (e: unknown) => e);
	expect(error).toBeInstanceOf(SyncSteelApiError);
	expect((error as SyncSteelApiError).status).toBe(status);
	if (message) {
		expect((error as SyncSteelApiError).message).toContain(message);
	}
};

describe('SyncSteelRoomApi', () => {
	it('creates a room, looks up its code and joins a seat', async () => {
		t = await startTestServer();
		const rooms = new SyncSteelRoomApi(`${t.base}/`);

		const created = await rooms.createRoom('Thursday group', 'Director', 'GM laptop');
		expect(created.room.name).toBe('Thursday group');
		expect(created.seat).toMatchObject({ name: 'Director', isGm: true });
		expect(created.joinCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

		const lookup = await rooms.lookup(created.joinCode.toLowerCase());
		expect(lookup).toEqual({ room: { name: 'Thursday group' }, seats: [ { id: created.seat.id, name: 'Director', isGm: true } ] });

		const alice = await rooms.join({ code: created.joinCode, newSeatName: 'Alice', deviceLabel: 'iPad (Safari)' });
		expect(alice.seat).toMatchObject({ name: 'Alice', isGm: false });
		const again = await rooms.join({ code: created.joinCode, seatId: alice.seat.id, deviceLabel: 'iPhone (Safari)' });
		expect(again.seat.id).toBe(alice.seat.id);
		expect(again.deviceToken).not.toBe(alice.deviceToken);

		const me = await new SyncSteelDeviceApi(t.base, again.deviceToken).me();
		expect(me).toMatchObject({ room: { name: 'Thursday group' }, seat: { name: 'Alice', isGm: false } });
	});

	it('reports the server\'s own messages', async () => {
		t = await startTestServer();
		const rooms = new SyncSteelRoomApi(t.base);
		const created = await rooms.createRoom('Table', 'GM', 'Laptop');

		await expectApiError(rooms.lookup('AAAAA-AAAAA'), 404, 'No room has that code');
		await expectApiError(rooms.join({ code: created.joinCode, seatId: created.seat.id, deviceLabel: 'Phone' }), 403);
		await expectApiError(rooms.join({ code: created.joinCode, newSeatName: 'GM', deviceLabel: 'Phone' }), 409);

		const gm = await rooms.join({ gmKey: created.gmKey, deviceLabel: 'GM iPad' });
		expect(gm.seat).toMatchObject({ id: created.seat.id, isGm: true });
	});

	it('says when the server can\'t be reached', async () => {
		await expectApiError(new SyncSteelRoomApi('http://127.0.0.1:9').lookup('AAAAA-AAAAA'), 0, 'Couldn\'t reach');
	});
});

describe('SyncSteelDeviceApi GM tools', () => {
	const setUp = async () => {
		dir = mkdtempSync(join(tmpdir(), 'sync-steel-client-'));
		t = await startTestServer({ snapshotDir: dir });
		const rooms = new SyncSteelRoomApi(t.base);
		const created = await rooms.createRoom('Thursday group', 'GM', 'GM laptop');
		const alice = await rooms.join({ code: created.joinCode, newSeatName: 'Alice', deviceLabel: 'iPad (Safari)' });
		const gm = new SyncSteelDeviceApi(t.base, created.deviceToken);
		return { rooms, created, alice, gm };
	};

	it('lists seats and devices, renames a seat and revokes a device', async () => {
		const { created, alice, gm } = await setUp();
		const server = t as TestServer;
		const aliceToken = (await server.connect(alice.deviceToken)).access_token;
		expect((await server.putHero(aliceToken, { id: 'hero-1', name: 'Kalla' })).status).toBe(204);

		const room = await gm.gmRoom();
		expect(room.room).toMatchObject({ name: 'Thursday group', lastExportAt: null });
		const aliceSeat = room.seats.find(s => s.id === alice.seat.id);
		expect(aliceSeat?.devices.map(d => d.label)).toEqual([ 'iPad (Safari)' ]);
		expect(aliceSeat?.heroes.map(h => h.name)).toEqual([ 'Kalla' ]);
		expect(room.seats.find(s => s.id === created.seat.id)?.devices[0].current).toBe(true);

		expect(await gm.renameSeat(alice.seat.id, 'Alice B')).toMatchObject({ name: 'Alice B' });

		const player = new SyncSteelDeviceApi(server.base, alice.deviceToken);
		await expect(player.me()).resolves.toMatchObject({ seat: { name: 'Alice B' } });
		await expectApiError(player.gmRoom(), 403);

		await gm.revokeDevice(aliceSeat?.devices[0].id as string);
		await expectApiError(player.me(), 401);
		await expectApiError(new SyncSteelDeviceApi(server.base, alice.deviceToken).me(), 401);
	});

	it('rotates the join code; the old one stops working', async () => {
		const { rooms, created, gm } = await setUp();
		const code = await gm.rotateJoinCode();
		expect(code).not.toBe(created.joinCode);
		await expectApiError(rooms.lookup(created.joinCode), 404);
		await expect(rooms.lookup(code)).resolves.toMatchObject({ room: { name: 'Thursday group' } });
	});

	it('renews an expired access token', async () => {
		const { gm } = await setUp();
		await gm.gmRoom();
		(t as TestServer).clock.now += 60 * 60 * 1000;
		await expect(gm.gmRoom()).resolves.toMatchObject({ room: { name: 'Thursday group' } });
	});

	it('exports, dry-runs an import, imports, and exports a snapshot', async () => {
		const { alice, gm } = await setUp();
		const server = t as TestServer;
		const aliceToken = (await server.connect(alice.deviceToken)).access_token;
		await server.putHero(aliceToken, { id: 'hero-1', name: 'Kalla' });

		const file = await gm.exportRoom();
		expect(file.filename).toBe('sync-steel-thursday-group-2026-11-22.json.gz');
		const payload = JSON.parse(gunzipSync(Buffer.from(file.bytes)).toString('utf8')) as { heroes: unknown[] };
		expect(payload.heroes).toHaveLength(1);
		expect((await gm.gmRoom()).room.lastExportAt).not.toBeNull();

		await server.putHero(aliceToken, { id: 'hero-1', name: 'Kalla the Bad Edit' });
		const dry = await gm.importRoom(file.bytes, true);
		expect(dry.heroes.updated).toBe(1);
		expect((await gm.gmRoom()).seats.flatMap(s => s.heroes).map(h => h.name)).toEqual([ 'Kalla the Bad Edit' ]);
		const real = await gm.importRoom(file.bytes, false);
		expect(real.heroes.updated).toBe(1);
		expect((await gm.gmRoom()).seats.flatMap(s => s.heroes).map(h => h.name)).toEqual([ 'Kalla' ]);

		expect(await gm.listSnapshots()).toEqual([]);
		createSnapshotter({ db: server.db, dir: dir as string, keep: 14, now: () => server.clock.now }).snapshotIfDue();
		expect(await gm.listSnapshots()).toEqual([ '2026-11-22' ]);
		const snapshot = await gm.exportSnapshot('2026-11-22');
		expect(snapshot.filename).toBe('sync-steel-thursday-group-2026-11-22-snapshot.json.gz');
		expect((await gm.importRoom(snapshot.bytes, true)).heroes.unchanged).toBe(1);
		await expectApiError(gm.exportSnapshot('2020-01-01'), 404);
	});
});
