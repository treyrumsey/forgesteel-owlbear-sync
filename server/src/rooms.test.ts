import { type TestServer, startTestServer } from './test-support.ts';
import { afterEach, describe, expect, it } from 'vitest';

let t: TestServer;

afterEach(async () => {
	await t.close();
});

describe('rooms and joining', () => {
	it('creates a room with a readable join code, a GM key and a GM device that can connect', async () => {
		t = await startTestServer();

		const room = await t.createRoom('Thursday group');
		const me = await (await t.call('/me', (await t.connect(room.deviceToken)).access_token)).json();

		expect(room.joinCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
		expect(room.gmKey).toMatch(/^ssgm_/);
		expect(room.deviceToken).toMatch(/^sst_/);
		expect(me).toMatchObject({ logged_in_as: 'GM', room: { name: 'Thursday group' }, seat: { isGm: true } });
	});

	it('stores only hashes of the room\'s secrets', async () => {
		t = await startTestServer();
		const room = await t.createRoom();

		const dump = JSON.stringify([ ...t.db.prepare('SELECT * FROM rooms').all(), ...t.db.prepare('SELECT * FROM devices').all() ]);

		expect(dump).not.toContain(room.gmKey);
		expect(dump).not.toContain(room.deviceToken);
		expect(dump).not.toContain(room.joinCode.replace('-', ''));
	});

	it('caps the number of rooms on the server', async () => {
		t = await startTestServer({ maxRooms: 1 });
		await t.createRoom();

		const response = await t.post('/rooms', { roomName: 'Second', deviceLabel: 'Laptop' });

		expect(response.status).toBe(403);
	});

	it('rate-limits room creation per IP', async () => {
		t = await startTestServer({ maxRooms: 100, rateLimits: { createRoom: { limit: 2, windowSeconds: 3600 } } });
		await t.createRoom('One');
		await t.createRoom('Two');

		const response = await t.post('/rooms', { roomName: 'Three', deviceLabel: 'Laptop' });

		expect(response.status).toBe(429);
		expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	it('looks up a room\'s seats by code, forgiving case, dashes and look-alike letters', async () => {
		t = await startTestServer();
		const room = await t.createRoom('Thursday group');
		await t.join({ code: room.joinCode, newSeatName: 'Alice' });
		const sloppy = room.joinCode.toLowerCase().replace('-', ' ').replace(/0/g, 'o').replace(/1/g, 'l');

		const response = await t.post('/join/lookup', { code: sloppy });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ room: { name: 'Thursday group' }, seats: [ { name: 'GM', isGm: true }, { name: 'Alice', isGm: false } ] });
	});

	it('lets a new device pick an existing seat to recover its heroes', async () => {
		t = await startTestServer();
		const room = await t.createRoom();
		const first = await t.join({ code: room.joinCode, newSeatName: 'Alice', deviceLabel: 'Old iPad' });
		await t.putHero((await t.connect(first.deviceToken)).access_token, { id: 'kalla', name: 'Kalla' });

		const second = await t.join({ code: room.joinCode, seatId: first.seat.id, deviceLabel: 'New iPad' });
		const heroes = await (await t.call('/data/forgesteel-heroes?fields=name', (await t.connect(second.deviceToken)).access_token)).json();

		expect(second.seat).toEqual(first.seat);
		expect(heroes).toEqual({ data: [ { id: 'kalla', name: 'Kalla' } ] });
	});

	it('refuses a duplicate seat name, ignoring case', async () => {
		t = await startTestServer();
		const room = await t.createRoom();
		await t.join({ code: room.joinCode, newSeatName: 'Alice' });

		const response = await t.post('/join', { code: room.joinCode, newSeatName: 'alice', deviceLabel: 'Phone' });

		expect(response.status).toBe(409);
	});

	it('needs the GM key to claim the GM seat, and lets the GM key alone sign in a new GM device', async () => {
		t = await startTestServer();
		const room = await t.createRoom();

		const withoutKey = await t.post('/join', { code: room.joinCode, seatId: room.seat.id, deviceLabel: 'Sneaky' });
		const withKey = await t.join({ code: room.joinCode, seatId: room.seat.id, gmKey: room.gmKey, deviceLabel: 'GM iPad' });
		const keyOnly = await t.join({ gmKey: room.gmKey, deviceLabel: 'GM desktop' });

		expect(withoutKey.status).toBe(403);
		expect(withKey.seat.isGm).toBe(true);
		expect(keyOnly.seat).toEqual(withKey.seat);
	});

	it('rejects a wrong code, and blocks an IP after too many wrong codes', async () => {
		t = await startTestServer({ rateLimits: { joinFailures: { limit: 2, windowSeconds: 600 } } });
		const room = await t.createRoom();

		const statuses = [];
		for (const code of [ 'AAAAA-AAAAA', 'not a code', room.joinCode ]) {
			statuses.push((await t.post('/join/lookup', { code: code })).status);
		}
		t.clock.now += 601 * 1000;
		statuses.push((await t.post('/join/lookup', { code: room.joinCode })).status);

		expect(statuses).toEqual([ 404, 404, 429, 200 ]);
	});

	it('blocks an IP after too many failed device tokens at /connect', async () => {
		t = await startTestServer({ rateLimits: { connectFailures: { limit: 2, windowSeconds: 600 } } });
		const room = await t.createRoom();

		const statuses = [];
		for (const token of [ 'wrong-1', 'wrong-2', room.deviceToken ]) {
			statuses.push((await t.call('/connect', token, { method: 'POST' })).status);
		}

		expect(statuses).toEqual([ 401, 401, 429 ]);
	});
});

describe('device revocation', () => {
	it('cuts a revoked device off at its next request, even with an unexpired access token', async () => {
		t = await startTestServer();
		const room = await t.createRoom();
		const lost = await t.join({ code: room.joinCode, newSeatName: 'Alice', deviceLabel: 'Lost phone' });
		const tokens = await t.connect(lost.deviceToken);
		const gm = (await t.connect(room.deviceToken)).access_token;
		const roomInfo = await (await t.call('/gm/room', gm)).json();
		const deviceId = roomInfo.seats.find((seat: { name: string }) => seat.name === 'Alice').devices[0].id;

		expect((await t.call(`/gm/devices/${deviceId}`, gm, { method: 'DELETE' })).status).toBe(204);

		const read = await t.call('/data/forgesteel-heroes', tokens.access_token);
		expect(read.status).toBe(401);
		expect((await read.json()).message).toContain('removed from the room');
		expect((await t.call('/refresh', tokens.refresh_token, { method: 'POST' })).status).toBe(401);
		expect((await t.call('/connect', lost.deviceToken, { method: 'POST' })).status).toBe(401);
	});
});
