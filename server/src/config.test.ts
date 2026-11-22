import { DEFAULT_DEV_DATABASE, loadConfig, parseList } from './config.ts';
import { describe, expect, it } from 'vitest';

const SECRETS = {
	JWT_SECRET: 'a'.repeat(32),
	JWT_REFRESH_SECRET: 'b'.repeat(32),
	TOKEN_HASH_KEY: 'c'.repeat(32)
};

describe('loadConfig', () => {
	it('runs locally with development secrets and a database under server/.data, and says so', () => {
		const { config, warnings } = loadConfig({});

		expect(config.production).toBe(false);
		expect(config.databasePath).toBe(DEFAULT_DEV_DATABASE);
		expect(config.corsOrigins).toEqual([ 'http://localhost:5173', 'http://127.0.0.1:5173' ]);
		expect(warnings[0]).toContain('JWT_SECRET, JWT_REFRESH_SECRET, TOKEN_HASH_KEY');
	});

	it('requires real secrets and a database path on Railway', () => {
		const railway = { RAILWAY_ENVIRONMENT_NAME: 'production' };

		expect(() => loadConfig(railway)).toThrow('JWT_SECRET must be set');
		expect(() => loadConfig({ ...railway, ...SECRETS, TOKEN_HASH_KEY: 'short' })).toThrow('TOKEN_HASH_KEY must be at least 32 characters');
		expect(() => loadConfig({ ...railway, ...SECRETS })).toThrow('DATABASE_PATH must be set');
		expect(loadConfig({ ...railway, ...SECRETS, DATABASE_PATH: '/data/sync-steel.db' }).config.production).toBe(true);
	});

	it('refuses the dev seed and reused secrets', () => {
		const railway = { RAILWAY_ENVIRONMENT_NAME: 'production', DATABASE_PATH: '/data/db', ...SECRETS };

		expect(() => loadConfig({ ...railway, DEV_SEED: '1' })).toThrow('DEV_SEED is for local development only');
		expect(() => loadConfig({ ...railway, JWT_REFRESH_SECRET: SECRETS.JWT_SECRET })).toThrow('must all be different');
	});

	it('reads numbers, flags and lists, and rejects bad numbers', () => {
		const { config } = loadConfig({ PORT: '9000', MAX_ROOMS: '3', TRUST_PROXY: 'true', CORS_ORIGINS: 'https://a.example, https://b.example' });

		expect(config).toMatchObject({ port: 9000, maxRooms: 3, trustProxy: true, corsOrigins: [ 'https://a.example', 'https://b.example' ] });
		expect(() => loadConfig({ MAX_ROOMS: 'lots' })).toThrow('MAX_ROOMS must be a whole number');
	});
});

describe('parseList', () => {
	it('splits on commas and drops blanks', () => {
		expect(parseList(' a, ,b ,')).toEqual([ 'a', 'b' ]);
	});
});
