import { type SocketLike, type StampedHero, SyncSteelSocket } from '@/sync-steel/live/sync-steel-socket';
import { TEST_ORIGIN, type TestServer, startTestServer } from './test-support.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FactoryLogic } from '@/logic/factory-logic';
import { WarehouseService } from '@/services/storage/warehouse-service';
import { WebSocket } from 'ws';

// Live sync end to end: two of Alice's devices, each with Forge Steel's own WarehouseService, and the
// iPad listening with the fork's SyncSteelSocket, against the real server

let t: TestServer;
const devices = { laptop: '', ipad: '' };

beforeAll(async () => {
	// Forge Steel reads the token's own exp, so the server keeps real time
	t = await startTestServer({ now: () => Date.now(), hub: { coalesceMs: 20, maxWaitMs: 100 } });
	const room = await t.createRoom();
	const alice = await t.join({ code: room.joinCode, newSeatName: 'Alice', deviceLabel: 'Laptop' });
	devices.laptop = alice.deviceToken;
	devices.ipad = (await t.join({ code: room.joinCode, seatId: alice.seat.id, deviceLabel: 'iPad' })).deviceToken;
});

afterAll(async () => {
	await t.close();
});

const warehouse = async (token: string) => {
	const service = new WarehouseService({ ...FactoryLogic.createConnectionSettings(), useManualWarehouse: true, warehouseHost: t.base, warehouseToken: token });
	await service.initialize();
	return service;
};

// A browser sends its page's Origin on the upgrade; Node's own WebSocket doesn't, so use ws's client
const listen = (token: string) => {
	const received: StampedHero[] = [];
	const socket = new SyncSteelSocket({
		host: t.base,
		deviceToken: token,
		onHero: hero => received.push(hero),
		onDeleted: () => undefined,
		onStatus: () => undefined,
		createSocket: url => new WebSocket(url, { headers: { Origin: TEST_ORIGIN } }) as unknown as SocketLike
	});
	socket.start();
	const next = async (predicate: (hero: StampedHero) => boolean) => {
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			const found = received.find(predicate);
			if (found) {
				return found;
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		throw new Error(`Nothing matched; received ${JSON.stringify(received.map(hero => hero._syncSteel))}`);
	};
	return { socket: socket, received: received, next: next };
};

describe('live sync end to end', () => {
	it('shows one device\'s save on another, and merges a stale save from it', async () => {
		const laptop = await warehouse(devices.laptop);
		const ipad = await warehouse(devices.ipad);
		const live = listen(devices.ipad);

		const hero = FactoryLogic.createHero();
		hero.id = 'e2e-hero';
		hero.name = 'Kalla';
		await laptop.putHero(hero);

		// The iPad is pushed the hero and applies it, which re-saves it: an echo, so still rev 1
		const first = await live.next(h => h._syncSteel?.rev === 1);
		await ipad.putHero(structuredClone(first));
		expect((await laptop.getHero('e2e-hero') as StampedHero)._syncSteel).toEqual({ rev: 1 });

		// The laptop takes damage
		hero.state.staminaDamage = 5;
		await laptop.putHero(hero);
		expect((await live.next(h => h._syncSteel?.rev === 2)).state.staminaDamage).toBe(5);

		// The iPad's hero page still held the rev 1 copy, and saves a note from it
		const stale = structuredClone(first);
		stale.state.notes = 'Owes Vex 10gp';
		await ipad.putHero(stale);

		// The merged hero keeps both changes, and is pushed back to the iPad to correct its screen
		const merged = await live.next(h => h._syncSteel?.rev === 3);
		expect(merged.state.staminaDamage).toBe(5);
		expect(merged.state.notes).toBe('Owes Vex 10gp');
		live.socket.stop();
	});
});
