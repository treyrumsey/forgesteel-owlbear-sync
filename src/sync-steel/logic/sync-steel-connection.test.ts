import { describe, expect, it } from 'vitest';
import { FactoryLogic } from '@/logic/factory-logic';
import { StorageServiceFactory } from '@/services/storage/storage-service-factory';
import { SyncSteelConnection } from '@/sync-steel/logic/sync-steel-connection';
import { WarehouseService } from '@/services/storage/warehouse-service';

const HOST = 'https://api.example.com';

describe('SyncSteelConnection', () => {
	it('writes manual Warehouse settings that upstream turns into a WarehouseService', () => {
		const settings = SyncSteelConnection.create(`${HOST}/`, 'device-token');
		expect(settings).toEqual({
			...FactoryLogic.createConnectionSettings(),
			useManualWarehouse: true,
			warehouseHost: HOST,
			warehouseToken: 'device-token'
		});
		expect(StorageServiceFactory.fromConnectionSettings(settings)).toBeInstanceOf(WarehouseService);
	});

	it('disconnects to local storage', () => {
		const settings = SyncSteelConnection.disconnect();
		expect(settings.useManualWarehouse).toBe(false);
		expect(StorageServiceFactory.fromConnectionSettings(settings)).not.toBeInstanceOf(WarehouseService);
	});

	it('knows when this browser is connected to the api', () => {
		expect(SyncSteelConnection.isConnected(SyncSteelConnection.create(HOST, 't'), `${HOST.toUpperCase()}/`)).toBe(true);
		expect(SyncSteelConnection.isConnected(SyncSteelConnection.create('https://other.example.com', 't'), HOST)).toBe(false);
		expect(SyncSteelConnection.isConnected(SyncSteelConnection.create(HOST, ''), HOST)).toBe(false);
		expect(SyncSteelConnection.isConnected(FactoryLogic.createConnectionSettings(), HOST)).toBe(false);
	});

	it('spots other remote storage that joining would replace', () => {
		expect(SyncSteelConnection.usesOtherStorage(SyncSteelConnection.create('https://other.example.com', 't'), HOST)).toBe(true);
		expect(SyncSteelConnection.usesOtherStorage({ ...FactoryLogic.createConnectionSettings(), usePatreonWarehouse: true }, HOST)).toBe(true);
		expect(SyncSteelConnection.usesOtherStorage(SyncSteelConnection.create(HOST, 't'), HOST)).toBe(false);
		expect(SyncSteelConnection.usesOtherStorage(FactoryLogic.createConnectionSettings(), HOST)).toBe(false);
	});

	it('labels devices from the user agent', () => {
		const label = SyncSteelConnection.defaultDeviceLabel;
		expect(label('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPad (Safari)');
		expect(label('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1')).toBe('iPhone (Chrome)');
		expect(label('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36')).toBe('Android phone (Chrome)');
		expect(label('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('Mac (Safari)');
		expect(label('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0')).toBe('Windows PC (Edge)');
		expect(label('')).toBe('Device');
	});
});
