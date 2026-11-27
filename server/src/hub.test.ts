import { HubClient, type PatchAnswer, type SocketLike, testConnection } from '../../obr-extension/src/hub-client.ts';
import { TEST_ORIGIN, type TestServer, startTestServer } from './test-support.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FactoryLogic } from '@/logic/factory-logic';
import type { HeroSummary } from '../../obr-extension/src/summary.ts';
import { Utils } from '@/utils/utils';
import { WebSocket } from 'ws';
import { fury } from '@/data/classes/fury/fury';

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
		while (!ipad.messages.slice(from).some(message => (message.type === 'hero') && (heroOf(message).id === 'live-3'))) {
			await ipad.next('hero', ipad.messages.length);
		}
		await wait(250);

		// The catch-up for the seat's other heroes can arrive after the welcome, so look at this hero only
		const pushes = ipad.messages.slice(from).filter(message => message.type === 'hero').map(heroOf).filter(hero => hero.id === 'live-3');
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

// A level 1 Fury, which upstream's HeroLogic gives 21 stamina and 10 recoveries (Phase 0)
const furyHero = (id: string, name: string) => {
	const hero = FactoryLogic.createHero();
	hero.id = id;
	hero.name = name;
	hero.class = Utils.copy(fury);
	hero.class.level = 1;
	return JSON.parse(JSON.stringify(hero)) as { id: string, name: string, state: { staminaDamage: number, notes: string } } & Record<string, unknown>;
};

const summaryOf = (message: Message) => message.summary as { heroId: string, rev: number, seatName: string, name: string, staminaMax: number, stamina: number, recoveries: number };

const summariesFor = (messages: Message[], heroId: string, from = 0) => {
	return messages.slice(from).filter(message => (message.type === 'summary') && (summaryOf(message).heroId === heroId)).map(summaryOf);
};

describe('Owlbear on the live sync hub', () => {
	let gmAccess: string;
	let owlbear: string;

	beforeAll(async () => {
		gmAccess = (await t.connect(room.deviceToken)).access_token;
		const response = await t.post('/gm/owlbear', {}, gmAccess);
		expect(response.status).toBe(201);
		owlbear = (await response.json() as { token: string }).token;
	});

	it('only lets the GM create an Owlbear token, which can\'t sign in to the Warehouse API', async () => {
		const playerAccess = (await t.connect(bob)).access_token;

		expect((await t.post('/gm/owlbear', {}, playerAccess)).status).toBe(403);
		const connect = await t.call('/connect', owlbear, { method: 'POST' });
		expect(connect.status).toBe(401);
		expect(await connect.json()).toEqual({ message: 'This is an Owlbear connection, not a device token' });
	});

	it('sends summaries of every hero in the room, never whole heroes', async () => {
		await save(alice.deviceToken, furyHero('obr-1', 'Kalla'));
		const socket = await open(owlbear);

		const welcome = await socket.next('welcome');
		await socket.next('synced');

		expect(welcome).toMatchObject({ kind: 'obr', room: { name: 'The Table' } });
		expect(summariesFor(socket.messages, 'obr-1')).toEqual([
			expect.objectContaining({ heroId: 'obr-1', rev: 1, seatName: 'Alice', name: 'Kalla', staminaMax: 21, stamina: 21, recoveries: 10 })
		]);
		expect(socket.messages.filter(message => message.type.startsWith('hero') && (message.type !== 'hero.deleted'))).toEqual([]);
		socket.close();
	});

	it('pushes a summary when the table stats change, and not when only the notes do', async () => {
		const hero = furyHero('obr-2', 'Vex');
		const access = await save(alice.deviceToken, hero);
		const socket = await open(owlbear, { 'obr-2': 1 });
		await socket.next('welcome');
		const from = socket.messages.length;

		hero.state.staminaDamage = 5;
		await t.putHero(access, hero);
		// The catch-up also sends the room's other heroes
		while (summariesFor(socket.messages, 'obr-2', from).length === 0) {
			await socket.next('summary', socket.messages.length);
		}
		hero.state.notes = 'Owes Bob';
		await t.putHero(access, hero);
		await wait(250);

		expect(summariesFor(socket.messages, 'obr-2', from)).toEqual([ expect.objectContaining({ rev: 2, stamina: 16 }) ]);
		socket.close();
	});

	it('pushes deletions', async () => {
		const access = await save(bob, furyHero('obr-3', 'Rook'));
		const socket = await open(owlbear, { 'obr-3': 1 });
		await socket.next('welcome');
		const from = socket.messages.length;

		await t.call('/data/forgesteel-heroes/obr-3', access, { method: 'DELETE' });

		expect(await socket.next('hero.deleted', from)).toEqual({ type: 'hero.deleted', heroId: 'obr-3' });
		socket.close();
	});

	it('lets every Owlbear client in the room connect with the shared token', async () => {
		const sockets = await Promise.all([ 1, 2, 3, 4, 5, 6 ].map(() => open(owlbear)));

		await Promise.all(sockets.map(socket => socket.next('welcome')));

		sockets.forEach(socket => expect(socket.ws.readyState).toBe(WebSocket.OPEN));
		sockets.forEach(socket => socket.close());
	});

	it('works with the extension\'s own hub client', async () => {
		const createSocket = (url: string) => new WebSocket(url, { headers: { Origin: TEST_ORIGIN } }) as unknown as SocketLike;
		const connection = { api: t.base, token: owlbear };
		const received = new Map<string, HeroSummary>();
		const deleted: string[] = [];
		let synced = 0;
		const client = new HubClient({
			connection: connection,
			createSocket: createSocket,
			onSummary: summary => received.set(summary.heroId, summary),
			onDeleted: heroId => deleted.push(heroId),
			onSynced: () => synced++,
			onStatus: () => undefined
		});
		const access = await save(bob, furyHero('obr-4', 'Moss'));

		client.start();
		while (synced === 0) {
			await wait(20);
		}
		await t.call('/data/forgesteel-heroes/obr-4', access, { method: 'DELETE' });
		while (deleted.length === 0) {
			await wait(20);
		}
		client.stop();

		expect(received.get('obr-4')).toMatchObject({ name: 'Moss', seatName: 'Bob', staminaMax: 21, resource: { name: 'Ferocity' } });
		expect(client.get('obr-4')).toBeNull();
		expect(deleted).toEqual([ 'obr-4' ]);
		expect(await testConnection(connection, 2000, createSocket)).toEqual({ ok: true, roomName: 'The Table' });
		expect(await testConnection({ api: t.base, token: bob }, 2000, createSocket)).toMatchObject({ ok: false, reason: expect.stringContaining('device token') });
		expect(await testConnection({ api: t.base, token: 'sst_nope' }, 2000, createSocket)).toEqual({ ok: false, reason: 'Invalid token' });
	});

	it('disconnects the old Owlbear token when the GM creates a new one', async () => {
		const socket = await open(owlbear);
		await socket.next('welcome');

		const response = await t.post('/gm/owlbear', {}, gmAccess);
		owlbear = (await response.json() as { token: string }).token;

		expect((await socket.closed).code).toBe(4001);
		const fresh = await open(owlbear);
		expect(await fresh.next('welcome')).toMatchObject({ kind: 'obr' });
		fresh.close();
	});
});

describe('Owlbear token edits (patches)', () => {
	let owlbear: string;
	let socket: Awaited<ReturnType<typeof open>>;
	let edits = 0;

	beforeAll(async () => {
		const gmAccess = (await t.connect(room.deviceToken)).access_token;
		owlbear = (await (await t.post('/gm/owlbear', {}, gmAccess)).json() as { token: string }).token;
		socket = await open(owlbear);
		await socket.next('synced');
	});

	afterAll(() => {
		socket.close();
	});

	// Sends a patch and resolves with its answer
	const send = async (patch: Record<string, unknown>, on = socket) => {
		const editId = (patch.editId as string | undefined) ?? `edit-${++edits}`;
		const from = on.messages.length;
		on.ws.send(JSON.stringify({ type: 'patch', editId: editId, ...patch }));
		for (;;) {
			const answer = on.messages.slice(from).find(message => ((message.type === 'ack') || (message.type === 'reject')) && (message.editId === editId));
			if (answer) {
				return answer;
			}
			await on.next('ack', on.messages.length).catch(() => undefined);
		}
	};

	const stored = async (heroId: string) => {
		const access = (await t.connect(room.deviceToken)).access_token;
		const response = await t.call(`/data/forgesteel-heroes/${heroId}`, access);
		return heroOf({ type: 'hero', hero: (await response.json() as { data: unknown }).data });
	};

	it('applies a token edit, acknowledges it, and pushes the new summary and the whole hero', async () => {
		await save(alice.deviceToken, furyHero('patch-1', 'Kalla'));
		await wait(150);
		const player = await open(alice.deviceToken, { 'patch-1': 1 });
		await player.next('welcome');
		await wait(50);
		const from = socket.messages.length;
		const playerFrom = player.messages.length;

		const answer = await send({ heroId: 'patch-1', baseRev: 1, values: { stamina: 16, temporaryStamina: 2, surges: 1 } });

		expect(answer).toEqual({ type: 'ack', editId: answer.editId, rev: 2, summaryRev: 2 });
		await socket.next('summary', from);
		expect(summariesFor(socket.messages, 'patch-1', from)).toEqual([ expect.objectContaining({ rev: 2, stamina: 16 }) ]);
		const pushed = heroOf(await player.next('hero', playerFrom));
		expect(pushed._syncSteel.rev).toBe(2);
		expect(pushed.state).toMatchObject({ staminaDamage: 5, staminaTemp: 2, surges: 1 });
		expect(t.logLines.some(line => line.includes(`Owlbear edit ${answer.editId as string}: hero patch-1 "Kalla" rev 1 -> 2`))).toBe(true);
		player.close();
	});

	it('combines a token edit with a change Forge Steel made since the token was synced', async () => {
		const hero = furyHero('patch-2', 'Vex');
		const access = await save(alice.deviceToken, hero);
		// Forge Steel: 5 damage, at rev 2. The token still shows rev 1, and takes 3 damage there.
		hero.state.staminaDamage = 5;
		expect((await t.putHero(access, { ...hero, _syncSteel: { rev: 1 } })).status).toBe(204);

		const answer = await send({ heroId: 'patch-2', baseRev: 1, values: { stamina: 18 } });

		expect(answer).toMatchObject({ type: 'ack', rev: 3, summaryRev: 3 });
		expect((await stored('patch-2')).state.staminaDamage).toBe(8);
	});

	it('adds and removes conditions by id, merged with Forge Steel\'s', async () => {
		const hero = furyHero('patch-3', 'Rook') as ReturnType<typeof furyHero> & { state: { conditions: unknown[] } };
		hero.state.conditions = [ { id: 'fs-1', type: 'Bleeding', text: '', ends: 'Save ends' } ];
		await save(alice.deviceToken, hero);

		const slowed = { id: 'obr-1', type: 'Slowed', text: '', ends: 'End of turn' };
		expect(await send({ heroId: 'patch-3', baseRev: 1, conditions: { add: [ slowed ] } })).toMatchObject({ type: 'ack', rev: 2 });
		expect(await send({ heroId: 'patch-3', baseRev: 2, conditions: { remove: [ 'fs-1' ] } })).toMatchObject({ type: 'ack', rev: 3 });

		expect((await stored('patch-3')).state.conditions).toEqual([ slowed ]);
	});

	it('applies an edit once, however many clients send it', async () => {
		await save(alice.deviceToken, furyHero('patch-4', 'Moss'));
		const tv = await open(owlbear);
		await tv.next('synced');
		const edit = { editId: 'token-9:2026-11-26T12:00:00.000Z', heroId: 'patch-4', baseRev: 1, values: { stamina: 11 } };

		const first = await send(edit);
		const second = await send(edit, tv);

		expect(second).toEqual(first);
		const stamped = await stored('patch-4');
		expect(stamped._syncSteel.rev).toBe(2);
		expect(stamped.state.staminaDamage).toBe(10);
		tv.close();
	});

	it('acknowledges an edit that changes nothing without a new revision', async () => {
		await save(alice.deviceToken, furyHero('patch-5', 'Wren'));

		expect(await send({ heroId: 'patch-5', baseRev: 1, values: { stamina: 21 } })).toMatchObject({ type: 'ack', rev: 1, summaryRev: 1 });
	});

	it.each([
		[ 'a value that isn\'t a number', { heroId: 'patch-1', baseRev: 2, values: { stamina: 'lots' } }, 'invalid' ],
		[ 'an edit with no changes', { heroId: 'patch-1', baseRev: 2, values: {} }, 'invalid' ],
		[ 'an unknown condition', { heroId: 'patch-1', baseRev: 2, conditions: { add: [ { id: 'x', type: 'Sleepy', text: '', ends: 'Save ends' } ] } }, 'invalid' ],
		[ 'an unknown hero', { heroId: 'nobody', baseRev: 1, values: { stamina: 1 } }, 'unknown-hero' ],
		[ 'a revision the server doesn\'t have', { heroId: 'patch-1', baseRev: 99, values: { stamina: 1 } }, 'base-gone' ]
	])('rejects %s', async (_name, patch, reason) => {
		expect(await send(patch)).toMatchObject({ type: 'reject', reason: reason });
	});

	it('ignores patches from Forge Steel devices', async () => {
		const device = await open(alice.deviceToken);
		await device.next('welcome');

		device.ws.send(JSON.stringify({ type: 'patch', editId: 'from-fs', heroId: 'patch-1', baseRev: 2, values: { stamina: 1 } }));
		await wait(150);

		expect(device.messages.filter(message => (message.type === 'ack') || (message.type === 'reject'))).toEqual([]);
		expect((await stored('patch-1')).state.staminaDamage).toBe(5);
		device.close();
	});

	it('works with the extension\'s own hub client, which waits for the catch-up before sending', async () => {
		await save(alice.deviceToken, furyHero('patch-7', 'Fern'));
		const answers: PatchAnswer[] = [];
		const client = new HubClient({
			connection: { api: t.base, token: owlbear },
			createSocket: url => new WebSocket(url, { headers: { Origin: TEST_ORIGIN } }) as unknown as SocketLike,
			onSummary: () => undefined,
			onDeleted: () => undefined,
			onSynced: () => undefined,
			onStatus: () => undefined,
			onAnswer: answer => answers.push(answer)
		});

		// Before it has connected: queued until the hub has caught it up
		client.start();
		client.patch({ heroId: 'patch-7', baseRev: 1, editId: 'client-1', values: { recoveries: 6 } });
		client.patch({ heroId: 'patch-7', baseRev: 1, editId: 'client-2', values: { stamina: 'x' as unknown as number } });
		while (answers.length < 2) {
			await wait(20);
		}
		client.stop();

		expect(answers).toEqual([
			{ type: 'ack', editId: 'client-1', rev: 2, summaryRev: 2 },
			{ type: 'reject', editId: 'client-2', reason: 'invalid' }
		]);
		expect((await stored('patch-7')).state.recoveriesUsed).toBe(4);
		// Stopped: a new patch is given up on at once
		client.patch({ heroId: 'patch-7', baseRev: 2, editId: 'client-3', values: { surges: 1 } });
		expect(answers[2]).toEqual({ type: 'reject', editId: 'client-3', reason: 'disconnected' });
	});

	it('gives a summary the revision at which it last changed, so every client agrees', async () => {
		const hero = furyHero('patch-6', 'Ash');
		const access = await save(alice.deviceToken, hero);
		await wait(150);
		hero.state.notes = 'Owes Bob';
		expect((await t.putHero(access, hero)).status).toBe(204);
		await wait(150);

		const late = await open(owlbear);
		await late.next('synced');
		expect(summariesFor(late.messages, 'patch-6')).toEqual([ expect.objectContaining({ rev: 1 }) ]);
		const caughtUp = await open(owlbear, { 'patch-6': 1 });
		await caughtUp.next('synced');
		expect(summariesFor(caughtUp.messages, 'patch-6')).toEqual([]);
		// A token synced at rev 1 can still be edited against it
		expect(await send({ heroId: 'patch-6', baseRev: 1, values: { surges: 2 } })).toMatchObject({ type: 'ack', rev: 3, summaryRev: 3 });
		expect((await stored('patch-6')).state).toMatchObject({ notes: 'Owes Bob', surges: 2 });
		late.close();
		caughtUp.close();
	});
});

describe('Owlbear on a server without the summary bundle', () => {
	it('turns the Owlbear extension away', async () => {
		const bare = await startTestServer({ summaries: null });
		const created = await bare.createRoom();
		const access = (await bare.connect(created.deviceToken)).access_token;
		const token = (await (await bare.post('/gm/owlbear', {}, access)).json() as { token: string }).token;

		const ws = new WebSocket(`${bare.base.replace('http', 'ws')}/live`, { headers: { Origin: TEST_ORIGIN } });
		const closed = new Promise<number>(resolve => ws.on('close', code => resolve(code)));
		ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: token, heroes: {} })));

		expect(await closed).toBe(4003);
		await bare.close();
	});
});
