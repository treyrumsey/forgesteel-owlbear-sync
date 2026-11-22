import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
	port: number;
	databasePath: string;
	corsOrigins: string[];
	jwtSecret: string;
	jwtRefreshSecret: string;
	tokenHashKey: string;
	accessTokenTtlSeconds: number;
	refreshTokenTtlSeconds: number;
	maxRooms: number;
	trustProxy: boolean;
	devSeed: boolean;
	production: boolean;
	revisionKeepLast: number;
	revisionDailyDays: number;
	// Null when snapshots are off
	snapshotDir: string | null;
	snapshotKeep: number;
}

export type Env = Record<string, string | undefined>;

// The fork's Vite dev server (npm start). Phase 2 adds the deployed fork's origin through CORS_ORIGINS.
export const DEFAULT_CORS_ORIGINS = [ 'http://localhost:5173', 'http://127.0.0.1:5173' ];

export const DEFAULT_DEV_DATABASE = fileURLToPath(new URL('../.data/dev.db', import.meta.url));

const SECRET_NAMES = [ 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'TOKEN_HASH_KEY' ] as const;
const MIN_SECRET_LENGTH = 32;

export const parseList = (value: string) => value.split(',').map(item => item.trim()).filter(item => item.length > 0);

const flag = (value: string | undefined) => [ '1', 'true', 'yes' ].includes((value ?? '').trim().toLowerCase());

// Railway sets these in every deployment
export const isProduction = (env: Env) => Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) || (env.NODE_ENV === 'production');

const integer = (env: Env, name: string, fallback: number, min: number) => {
	const raw = env[name]?.trim();
	if (!raw) {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || (value < min)) {
		throw new Error(`${name} must be a whole number of at least ${min}`);
	}
	return value;
};

// Throws with a message that names the variable, but never echoes a secret's value
export const loadConfig = (env: Env): { config: ServerConfig, warnings: string[] } => {
	const production = isProduction(env);
	const warnings: string[] = [];

	const defaulted: string[] = [];
	const [ jwtSecret, jwtRefreshSecret, tokenHashKey ] = SECRET_NAMES.map(name => {
		const value = env[name];
		if (value) {
			if (production && (value.length < MIN_SECRET_LENGTH)) {
				throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
			}
			return value;
		}
		if (production) {
			throw new Error(`${name} must be set`);
		}
		defaulted.push(name);
		return `dev-only-${name.toLowerCase()}-not-for-production`;
	});
	if (defaulted.length > 0) {
		warnings.push(`using fixed development values for ${defaulted.join(', ')}; never do this in production`);
	}
	if (new Set([ jwtSecret, jwtRefreshSecret, tokenHashKey ]).size < SECRET_NAMES.length) {
		throw new Error('JWT_SECRET, JWT_REFRESH_SECRET and TOKEN_HASH_KEY must all be different');
	}

	const databasePath = env.DATABASE_PATH?.trim() || (production ? '' : DEFAULT_DEV_DATABASE);
	if (!databasePath) {
		throw new Error('DATABASE_PATH must be set to a file on the volume, such as /data/sync-steel.db');
	}

	const snapshotKeep = integer(env, 'SNAPSHOT_KEEP', 14, 0);
	const snapshotDir = ((databasePath === ':memory:') || (snapshotKeep === 0))
		? null
		: env.SNAPSHOT_DIR?.trim() || join(dirname(databasePath), 'snapshots');

	const devSeed = flag(env.DEV_SEED);
	if (devSeed && production) {
		throw new Error('DEV_SEED is for local development only');
	}

	return {
		config: {
			port: integer(env, 'PORT', 8787, 0),
			databasePath: databasePath,
			corsOrigins: env.CORS_ORIGINS ? parseList(env.CORS_ORIGINS) : DEFAULT_CORS_ORIGINS,
			jwtSecret: jwtSecret,
			jwtRefreshSecret: jwtRefreshSecret,
			tokenHashKey: tokenHashKey,
			accessTokenTtlSeconds: integer(env, 'ACCESS_TOKEN_TTL_SECONDS', 15 * 60, 1),
			refreshTokenTtlSeconds: integer(env, 'REFRESH_TOKEN_TTL_SECONDS', 90 * 24 * 60 * 60, 60),
			maxRooms: integer(env, 'MAX_ROOMS', 10, 0),
			trustProxy: flag(env.TRUST_PROXY),
			devSeed: devSeed,
			production: production,
			revisionKeepLast: integer(env, 'REVISION_KEEP_LAST', 100, 1),
			revisionDailyDays: integer(env, 'REVISION_DAILY_DAYS', 90, 0),
			snapshotDir: snapshotDir,
			snapshotKeep: snapshotKeep
		},
		warnings: warnings
	};
};
