import { type TestServer, startTestServer } from './test-support.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionSettings } from '@/models/connection-settings';
import { FactoryLogic } from '@/logic/factory-logic';
import { Hero } from '@/models/hero';
import { Sourcebook } from '@/models/sourcebook';
import { WarehouseService } from '@/services/storage/warehouse-service';

// Forge Steel's own, unmodified WarehouseService talking to the server over real HTTP:
// the fork's storage layer needs no code changes to use the Sync Steel backend.

type StampedHero = Hero & { _syncSteel?: { rev: number } };

// Forge Steel reads the token's own exp, so the server's clock starts at the real time
let clock = Date.now();
let t: TestServer;
let host = '';
const devices = { alice: '', bob: '' };

beforeAll(async () => {
	t = await startTestServer({ now: () => clock });
	host = t.base;
	const room = await t.createRoom();
	devices.alice = (await t.join({ code: room.joinCode, newSeatName: 'Alice' })).deviceToken;
	devices.bob = (await t.join({ code: room.joinCode, newSeatName: 'Bob' })).deviceToken;
});

afterAll(async () => {
	await t.close();
});

const connect = async (warehouseToken: string) => {
	const settings: ConnectionSettings = {
		useManualWarehouse: true,
		warehouseHost: host,
		warehouseToken: warehouseToken,
		patreonConnected: false,
		usePatreonWarehouse: false,
		patreonConnections: [],
		dataSource: undefined
	};
	const service = new WarehouseService(settings);
	expect(await service.initialize()).toBe(true);
	return service;
};

describe('upstream WarehouseService against the Sync Steel server', () => {
	it('saves, lists, loads, re-saves and deletes a hero', async () => {
		const service = await connect(devices.alice);
		const hero = FactoryLogic.createHero();
		hero.id = 'compat-hero';
		hero.name = 'Kalla';
		hero.folder = 'Party';

		await service.putHero(hero);
		expect(await service.getHeroes()).toEqual([ { id: 'compat-hero', name: 'Kalla', folder: 'Party' } ]);

		const loaded = await service.getHero('compat-hero') as StampedHero;
		expect(loaded._syncSteel).toEqual({ rev: 1 });

		loaded.state.staminaDamage = 4;
		await service.putHero(loaded);
		const reloaded = await service.getHero('compat-hero') as StampedHero;
		expect(reloaded.state.staminaDamage).toBe(4);
		expect(reloaded._syncSteel).toEqual({ rev: 2 });

		await service.deleteHero('compat-hero');
		expect(await service.getHeroes()).toEqual([]);
	});

	it('saves and loads homebrew, session and hidden sourcebook ids', async () => {
		const service = await connect(devices.bob);
		const sourcebook = FactoryLogic.createSourcebook();
		sourcebook.id = 'compat-homebrew';
		const session = FactoryLogic.createSession();

		await service.putSourcebook(sourcebook);
		await service.putSession(session);
		await service.putHiddenSourcebookIDs([ 'orden' ]);

		expect((await service.getSourcebooks()).map((s: Sourcebook) => s.id)).toEqual([ 'compat-homebrew' ]);
		expect((await service.getSourcebook('compat-homebrew'))?.id).toBe('compat-homebrew');
		expect(await service.getSession()).toEqual(session);
		expect(await service.getHiddenSourcebookIDs()).toEqual([ 'orden' ]);
	});

	it('recovers from an expired access token by refreshing and retrying', async () => {
		const service = await connect(devices.alice);
		t.logLines.length = 0;

		// The server's clock moves past the token's expiry, but the client's doesn't,
		// so the client sends the token and must handle the server's 401
		clock += 16 * 60 * 1000;
		const heroes = await service.getHeroes();

		expect(heroes).toEqual([]);
		const statuses = t.logLines.filter(line => / (GET|POST) \//.test(line)).map(line => line.split(' ').slice(-3).join(' '));
		expect(statuses).toEqual([
			'GET /data/forgesteel-heroes?fields=name,folder 401',
			'POST /refresh 200',
			'GET /data/forgesteel-heroes?fields=name,folder 200'
		]);
	});

	// Forge Steel shows the reference Warehouse's {message} body to the user
	it('shows the server\'s error message for an unknown device token', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const service = new WarehouseService({
			useManualWarehouse: true,
			warehouseHost: host,
			warehouseToken: 'not-a-device',
			patreonConnected: false,
			usePatreonWarehouse: false,
			patreonConnections: [],
			dataSource: undefined
		});

		await expect(service.initialize()).rejects.toThrow('FS Warehouse Error: [401] Invalid token');
	});
});
