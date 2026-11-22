import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionSettings } from '@/models/connection-settings';
import { DataManager } from '@/contexts/data-context';
import { DataService } from '@/services/data-service';
import { FactoryLogic } from '@/logic/factory-logic';
import { Hero } from '@/models/hero';
import { HeroLogic } from '@/logic/hero-logic';
import { HeroUpdateLogic } from '@/logic/update/hero-update-logic';
import { LocalService } from '@/services/storage/local-service';
import MockAdapter from 'axios-mock-adapter';
import { Utils } from '@/utils/utils';
import { WarehouseService } from '@/services/storage/warehouse-service';
import axios from 'axios';
import { core } from '@/data/sourcebooks/official/core';
import { fury } from '@/data/classes/fury/fury';
import localforage from 'localforage';
import { orden } from '@/data/sourcebooks/official/orden';

// The server's three-way merge (report §4.4) relies on a revision stamp that Forge Steel carries,
// untouched, from load to save. These tests fail if upstream starts dropping unknown top-level fields.

vi.mock('axios', async () => {
	return {
		...(await vi.importActual('axios') as object),
		create: vi.fn().mockReturnValue(await vi.importActual('axios'))
	};
});

vi.mock('localforage');

type StampedHero = Hero & { _syncSteel?: { rev: number } };

const buildStampedHero = (): StampedHero => {
	const hero: StampedHero = FactoryLogic.createHero();
	hero.id = 'stamped-hero';
	hero.name = 'Stamped';
	hero.class = Utils.copy(fury);
	hero.class.level = 1;
	hero._syncSteel = { rev: 7 };
	return hero;
};

const settings: ConnectionSettings = {
	useManualWarehouse: true,
	warehouseHost: 'http://test-fake-host',
	warehouseToken: 'device-token',
	patreonConnected: false,
	usePatreonWarehouse: false,
	patreonConnections: [],
	dataSource: undefined
};

describe('a top-level _syncSteel stamp on a hero', () => {
	const mockAdapter = new MockAdapter(axios);

	afterEach(() => {
		mockAdapter.reset();
	});

	it('survives Utils.copy', () => {
		const copy = Utils.copy(buildStampedHero());

		expect(copy._syncSteel).toEqual({ rev: 7 });
	});

	it('survives HeroUpdateLogic.updateHero', () => {
		const hero = buildStampedHero();

		HeroUpdateLogic.updateHero(hero, [ core, orden ]);

		expect(hero._syncSteel).toEqual({ rev: 7 });
	});

	it('survives a Warehouse load, an edit and a save', async () => {
		const putBodies: StampedHero[] = [];
		mockAdapter.onPost('http://test-fake-host/connect').reply(200, { access_token: 'jwt', refresh_token: 'refresh' });
		mockAdapter.onGet('data/forgesteel-heroes/stamped-hero').reply(200, { data: JSON.parse(JSON.stringify(buildStampedHero())) });
		mockAdapter.onPut('data/forgesteel-heroes/stamped-hero').reply(config => {
			putBodies.push(JSON.parse(config.data));
			return [ 204 ];
		});

		const dataService = new DataService(new WarehouseService(settings));
		expect(await dataService.initialize()).toBe(true);

		// Load, as the data loader does
		const loaded = await dataService.getHero('stamped-hero') as StampedHero;
		HeroUpdateLogic.updateHero(loaded, [ core, orden ]);

		// Edit a copy, as the modals do
		const edited = Utils.copy(loaded);
		edited.state.staminaDamage = 6;

		// Save, as usePersistence.persistHero does after its debounce
		const copy = Utils.copy(edited);
		HeroLogic.updateKitDamageBonusSelections(copy);
		const heroDispatch = vi.fn();
		const dataManager = new DataManager(dataService, {
			options: vi.fn(),
			session: vi.fn(),
			hiddenSourcebooks: vi.fn(),
			hero: heroDispatch,
			sourcebooks: vi.fn()
		});
		await dataManager.saveHero(copy);

		expect(putBodies).toHaveLength(1);
		expect(putBodies[0]._syncSteel).toEqual({ rev: 7 });
		expect(putBodies[0].state.staminaDamage).toBe(6);
		expect(heroDispatch.mock.lastCall?.[0].payload._syncSteel).toEqual({ rev: 7 });
	});

	it('survives a local save and reload', async () => {
		// IndexedDB stores a structured clone of the value
		let stored: Hero[] | null = null;
		localforage.getItem = vi.fn().mockImplementation(() => Promise.resolve(structuredClone(stored)));
		localforage.setItem = vi.fn().mockImplementation((_key: string, value: Hero[]) => {
			stored = structuredClone(value);
			return Promise.resolve(value);
		});

		const dataService = new DataService(new LocalService());
		await dataService.saveHero(buildStampedHero());
		const reloaded = await dataService.getHero('stamped-hero') as StampedHero | null;

		expect(reloaded?._syncSteel).toEqual({ rev: 7 });
	});
});
