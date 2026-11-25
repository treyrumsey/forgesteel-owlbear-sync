import { TEST_ORIGIN, type TestServer, startTestServer } from './test-support.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

// The live-sync hub (hub.ts), over real sockets

interface Message {
	type: string;
	[key: string]: unknown;
}

let t: TestServer;
let room: Awaited<ReturnType<TestServer['createRoom']>>;
let alice: { seat: { id: string }, deviceToken: string };
let aliceIpad: string;
let bob: string;

beforeAll(async () => {
	t = await startTestServer({ hub: { coalesceMs: 100, maxWaitMs: 1000, helloTimeoutMs: 300 } });
	room = await t.createRoom();
	alice = await t.join({ code: room.joinCode, newSeatName: 'Alice', deviceLabel: 'Alice laptop' });
	aliceIpad = (await t.join({ code: room.joinCode, seatId: alice.seat.id, deviceLabel: 'Alice iPad' })).deviceToken;
	bob = (await t.join({ code: room.joinCode, newSeatName: 'Bob' })).deviceToken;
});

afterAll(async () => {
	await t.close();
});

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Opens a socket and collects what it receives. hello: false skips the first message.
const open = async (token: string | null, heroes: Record<string, number> = {}, origin = TEST_ORIGIN) => {
	const ws = new WebSocket(`${t.base.replace('http', 'ws')}/live`, { headers: { Origin: origin } });
	const messages: Message[] = [];
	const waiters: (() => void)[] = [];
	ws.on('message', data => {
		messages.push(JSON.parse(data.toString()) as Message);
		waiters.splice(0).forEach(resolve => resolve());
	});
	const closed = new Promise<{ code: number, reason: string }>(resolve => {
		ws.on('close', (code, reason) => resolve({ code: code, reason: reason.toString() }));
	});
	const rejected = new Promise<number>(resolve => {
		ws.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
	});
	ws.on('error', () => undefined);
	const opened = await Promise.race([
		new Promise<boolean>(resolve => ws.on('open', () => resolve(true))),
		rejected.then(() => false)
	]);
	if (opened && token !== null) {
		ws.send(JSON.stringify({ type: 'hello', token: token, heroes: heroes }));
	}

	// Resolves with the first message of this type received after `from`
	const next = async (type: string, from = 0, timeoutMs = 1000): Promise<Message> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = messages.slice(from).find(message => message.type === type);
			if (found) {
				return found;
			}
			if (Date.now() > deadline) {
				throw new Error(`No ${type} message; got ${JSON.stringify(messages)}`);
			}
			await Promise.race([ new Promise<void>(resolve => waiters.push(resolve)), wait(50) ]);
		}
	};

	return { ws: ws, messages: messages, next: next, closed: closed, rejected: rejected, opened: opened, close: () => ws.close() };
};

const save = async (deviceToken: string, hero: { id: string } & Record<string, unknown>) => {
	const access = (await t.connect(deviceToken)).access_token;
	const response = await t.putHero(access, hero);
	expect(response.status).toBe(204);
	return access;
};

const heroOf = (message: Message) => message.hero as { id: string, name: string, state: Record<string, unknown>, _syncSteel: { rev: number } };

describe('live sync hub', () => {
	it('welcomes a device that sends its token', async () => {
		const socket = await open(alice.deviceToken);

		const welcome = await socket.next('welcome');

		expect(welcome.seat).toEqual({ id: alice.seat.id, isGm: false });
		socket.close();
	});

	it('refuses an upgrade from another origin', async () => {
		const socket = await open(alice.deviceToken, {}, 'https://forgesteel.net');

		expect(socket.opened).toBe(false);
		expect(await socket.rejected).toBe(403);
	});

	it('closes a socket with a bad token, or with no hello', async () => {
		const bad = await open('not-a-token');
		const silent = await open(null);

		expect((await bad.closed).code).toBe(4001);
		expect((await silent.closed).code).toBe(4000);
	});

	it('pushes a saved hero to the seat\'s other devices and the GM, but not to other players', async () => {
		const ipad = await open(aliceIpad);
		const gm = await open(room.deviceToken);
		const other = await open(bob);
		await Promise.all([ ipad.next('welcome'), gm.next('welcome'), other.next('welcome') ]);
		const from = { ipad: ipad.messages.length, gm: gm.messages.length, other: other.messages.length };

		await save(alice.deviceToken, { id: 'live-1', name: 'Kalla', state: { staminaDamage: 3 } });

		const pushed = heroOf(await ipad.next('hero', from.ipad));
		expect(pushed).toMatchObject({ id: 'live-1', state: { staminaDamage: 3 }, _syncSteel: { rev: 1 } });
		expect(heroOf(await gm.next('hero', from.gm)).id).toBe('live-1');
		await wait(100);
		expect(other.messages.slice(from.other).filter(message => message.type === 'hero')).toEqual([]);
		[ ipad, gm, other ].forEach(socket => socket.close());
	});

	it('tells the saving device only the revision, unless the save was merged', async () => {
		const laptop = await open(alice.deviceToken);
		await laptop.next('welcome');
		let from = laptop.messages.length;

		const access = await save(alice.deviceToken, { id: 'live-2', name: 'Vex', state: { staminaDamage: 0, notes: '' } });
		expect(await laptop.next('hero.own', from)).toEqual({ type: 'hero.own', heroId: 'live-2', rev: 1 });

		// The iPad changes stamina; the laptop then saves a note from its rev 1 copy, which is merged
		await save(aliceIpad, { id: 'live-2', name: 'Vex', state: { staminaDamage: 4, notes: '' }, _syncSteel: { rev: 1 } });
		await laptop.next('hero', from);
		from = laptop.messages.length;
		await t.putHero(access, { id: 'live-2', name: 'Vex', state: { staminaDamage: 0, notes: 'Owes Bob' }, _syncSteel: { rev: 1 } });

		expect(heroOf(await laptop.next('hero', from)).state).toEqual({ staminaDamage: 4, notes: 'Owes Bob' });
		laptop.close();
	});

	it('coalesces a burst of saves into one push of the latest revision', async () => {
		const ipad = await open(aliceIpad);
		await ipad.next('welcome');
		const from = ipad.messages.length;

		const access = await save(alice.deviceToken, { id: 'live-3', name: 'Sol', state: { staminaDamage: 1 } });
		await t.putHero(access, { id: 'live-3', name: 'Sol', state: { staminaDamage: 2 } });
		await t.putHero(access, { id: 'live-3', name: 'Sol', state: { staminaDamage: 3 } });
		await ipad.next('hero', from);
		await wait(250);

		const pushes = ipad.messages.slice(from).filter(message => message.type === 'hero').map(heroOf);
		expect(pushes.map(hero => hero._syncSteel.rev)).toEqual([ 3 ]);
		ipad.close();
	});

	it('catches a reconnecting device up on what changed, and on what was deleted', async () => {
		const access = await save(alice.deviceToken, { id: 'live-4', name: 'Ash', state: {} });
		await save(alice.deviceToken, { id: 'live-5', name: 'Rook', state: {} });
		await t.putHero(access, { id: 'live-4', name: 'Ash', state: { surges: 2 } });
		await t.call('/data/forgesteel-heroes/live-5', access, { method: 'DELETE' });

		const ipad = await open(aliceIpad, { 'live-4': 1, 'live-5': 1, 'live-1': 1 });
		await ipad.next('welcome');
		await wait(100);

		const heroIds = ipad.messages.filter(message => message.type === 'hero').map(message => heroOf(message).id);
		const deleted = ipad.messages.filter(message => message.type === 'hero.deleted').map(message => message.heroId);
		expect(heroIds).toContain('live-4');
		expect(heroIds).not.toContain('live-1');
		expect(deleted).toEqual([ 'live-5' ]);
		ipad.close();
	});

	it('pushes deletions to the devices that could see the hero', async () => {
		const access = await save(alice.deviceToken, { id: 'live-6', name: 'Wren', state: {} });
		const gm = await open(room.deviceToken);
		await gm.next('welcome');
		const from = gm.messages.length;

		await t.call('/data/forgesteel-heroes/live-6', access, { method: 'DELETE' });

		expect(await gm.next('hero.deleted', from)).toEqual({ type: 'hero.deleted', heroId: 'live-6' });
		gm.close();
	});

	it('answers pings', async () => {
		const socket = await open(alice.deviceToken);
		await socket.next('welcome');

		socket.ws.send(JSON.stringify({ type: 'ping' }));

		expect(await socket.next('pong')).toEqual({ type: 'pong' });
		socket.close();
	});

	it('closes a revoked device\'s sockets at once', async () => {
		const phone = await t.join({ code: room.joinCode, seatId: alice.seat.id, deviceLabel: 'Spare phone' });
		const socket = await open(phone.deviceToken);
		await socket.next('welcome');
		const gmAccess = (await t.connect(room.deviceToken)).access_token;
		const id = t.services.rooms.listDevices(room.room.id).find(device => device.label === 'Spare phone')?.id;
		expect(id).toBeDefined();

		await t.call(`/gm/devices/${id}`, gmAccess, { method: 'DELETE' });

		expect((await socket.closed).code).toBe(4001);
	});

	it('makes a repeated hero delete succeed, so a device can catch up on a remote delete', async () => {
		const access = await save(alice.deviceToken, { id: 'live-7', name: 'Moss', state: {} });

		expect((await t.call('/data/forgesteel-heroes/live-7', access, { method: 'DELETE' })).status).toBe(204);
		expect((await t.call('/data/forgesteel-heroes/live-7', access, { method: 'DELETE' })).status).toBe(204);
		expect((await t.call('/data/forgesteel-heroes/never-was', access, { method: 'DELETE' })).status).toBe(404);
	});
});
