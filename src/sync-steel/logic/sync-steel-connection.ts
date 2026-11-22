import { ConnectionSettings } from '@/models/connection-settings';
import { FactoryLogic } from '@/logic/factory-logic';

// Sync Steel connects Forge Steel to its api through upstream's own manual Warehouse settings,
// so the unmodified WarehouseService stores the heroes. A device token is the Warehouse token.

const sameHost = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

export class SyncSteelConnection {
	static create = (host: string, deviceToken: string): ConnectionSettings => {
		return {
			...FactoryLogic.createConnectionSettings(),
			useManualWarehouse: true,
			warehouseHost: host.trim().replace(/\/+$/, ''),
			warehouseToken: deviceToken
		};
	};

	// Back to this browser's own storage. Heroes on the server stay there.
	static disconnect = (): ConnectionSettings => FactoryLogic.createConnectionSettings();

	// This browser saves to the Sync Steel api at this host
	static isConnected = (settings: ConnectionSettings, host: string) => {
		return settings.useManualWarehouse && !settings.usePatreonWarehouse && !!settings.warehouseToken && sameHost(settings.warehouseHost, host);
	};

	// A manual Warehouse that isn't this api, or Patreon storage: joining would replace it
	static usesOtherStorage = (settings: ConnectionSettings, host: string) => {
		if (SyncSteelConnection.isConnected(settings, host)) {
			return false;
		}
		return settings.useManualWarehouse || settings.usePatreonWarehouse;
	};

	// A readable default for the GM's device list, such as "iPad (Safari)"
	static defaultDeviceLabel = (userAgent: string) => {
		const first = (rules: [ RegExp, string ][]) => rules.find(([ pattern ]) => pattern.test(userAgent))?.[1] ?? null;
		const device = first([
			[ /iPad/, 'iPad' ],
			[ /iPhone/, 'iPhone' ],
			[ /Android.*Mobile/, 'Android phone' ],
			[ /Android/, 'Android tablet' ],
			[ /Macintosh/, 'Mac' ],
			[ /Windows/, 'Windows PC' ],
			[ /Linux|CrOS/, 'Computer' ]
		]) ?? 'Device';
		const browser = first([
			[ /Edg\//, 'Edge' ],
			[ /Firefox\/|FxiOS/, 'Firefox' ],
			[ /Chrome\/|CriOS/, 'Chrome' ],
			[ /Safari\//, 'Safari' ]
		]);
		return browser ? `${device} (${browser})` : device;
	};
}
