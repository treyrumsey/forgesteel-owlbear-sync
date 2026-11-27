import { type EventBus, createEventBus } from './events.ts';
import { type HeroStore, type Retention, createHeroStore } from './store/heroes.ts';
import { type HomebrewStore, createHomebrewStore } from './store/homebrew.ts';
import { type RateLimiter, type RateRule, createRateLimiter } from './rate-limit.ts';
import { type RoomStore, createRoomStore } from './store/rooms.ts';
import { type SeatDataStore, createSeatDataStore } from './store/seat-data.ts';
import { type SecretKind, hashSecret } from './secrets.ts';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http.ts';
import type { SummaryTools } from './summary.ts';

export interface BodyLimits {
	hero: number;
	homebrew: number;
	seatData: number;
	import: number;
	small: number;
}

export interface RateLimits {
	createRoom: RateRule;
	join: RateRule;
	joinFailures: RateRule;
	joinFailuresGlobal: RateRule;
	connect: RateRule;
	connectFailures: RateRule;
	// Token edits from Owlbear, per Owlbear token: every client in the Owlbear room shares it
	owlbearPatches: RateRule;
}

const MB = 1024 * 1024;

export const DEFAULT_BODY_LIMITS: BodyLimits = {
	hero: 5 * MB,
	homebrew: 20 * MB,
	seatData: 20 * MB,
	import: 50 * MB,
	small: 64 * 1024
};

// Everyone at an in-person table shares one public IP, so the per-IP limits allow for a whole group
export const DEFAULT_RATE_LIMITS: RateLimits = {
	createRoom: { limit: 5, windowSeconds: 60 * 60 },
	join: { limit: 30, windowSeconds: 10 * 60 },
	joinFailures: { limit: 20, windowSeconds: 10 * 60 },
	joinFailuresGlobal: { limit: 300, windowSeconds: 60 * 60 },
	connect: { limit: 120, windowSeconds: 10 * 60 },
	connectFailures: { limit: 20, windowSeconds: 10 * 60 },
	owlbearPatches: { limit: 300, windowSeconds: 60 }
};

export interface Secrets {
	jwt: string;
	jwtRefresh: string;
	tokenHash: string;
}

export interface ServiceOptions {
	db: DatabaseSync;
	secrets: Secrets;
	accessTokenTtlSeconds?: number;
	refreshTokenTtlSeconds?: number;
	maxRooms?: number;
	trustProxy?: boolean;
	revisionKeepLast?: number;
	revisionDailyDays?: number;
	bodyLimits?: Partial<BodyLimits>;
	rateLimits?: Partial<RateLimits>;
	// Where the daily database snapshots are, if any
	snapshotDir?: string | null;
	now?: () => number;
	log?: (line: string) => void;
	events?: EventBus;
	// Hero summaries and token patches for the Owlbear extension; null turns Owlbear connections away
	summaries?: SummaryTools | null;
}

export interface Services {
	db: DatabaseSync;
	rooms: RoomStore;
	heroes: HeroStore;
	homebrew: HomebrewStore;
	seatData: SeatDataStore;
	events: EventBus;
	summaries: SummaryTools | null;
	limiter: RateLimiter;
	rateLimits: RateLimits;
	bodyLimits: BodyLimits;
	secrets: Secrets;
	accessTokenTtlSeconds: number;
	refreshTokenTtlSeconds: number;
	maxRooms: number;
	trustProxy: boolean;
	snapshotDir: string | null;
	now: () => number;
	nowIso: () => string;
	log: (line: string) => void;
	hashSecret: (kind: SecretKind, value: string) => string;
	// Counts an attempt against a rate limit, and throws 429 if it's used up
	limit: (key: string, rule: RateRule) => void;
	// Throws 429 if a failure limit is used up, without counting
	checkFailures: (key: string, rule: RateRule) => void;
}

export interface Principal {
	roomId: string;
	seatId: string;
	seatName: string;
	isGm: boolean;
	deviceId: string;
	sid: string;
}

export interface AppEnv {
	Variables: {
		principal: Principal;
	};
}

const tooManyRequests = (wait: number) => {
	return new HttpError(429, { message: 'Too many attempts. Wait a few minutes, then try again.' }, { 'Retry-After': String(wait) });
};

export const createServices = (options: ServiceOptions): Services => {
	const now = options.now ?? Date.now;
	const nowIso = () => new Date(now()).toISOString();
	const refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 90 * 24 * 60 * 60;
	const retention: Retention = {
		keepLast: options.revisionKeepLast ?? 100,
		dailyDays: options.revisionDailyDays ?? 90,
		sessionDays: Math.ceil(refreshTokenTtlSeconds / (24 * 60 * 60)) + 1
	};
	const limiter = createRateLimiter(now);

	return {
		db: options.db,
		rooms: createRoomStore(options.db, nowIso),
		heroes: createHeroStore(options.db, now, retention),
		homebrew: createHomebrewStore(options.db, nowIso),
		seatData: createSeatDataStore(options.db, nowIso),
		events: options.events ?? createEventBus(),
		summaries: options.summaries ?? null,
		limiter: limiter,
		rateLimits: { ...DEFAULT_RATE_LIMITS, ...options.rateLimits },
		bodyLimits: { ...DEFAULT_BODY_LIMITS, ...options.bodyLimits },
		secrets: options.secrets,
		accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? 15 * 60,
		refreshTokenTtlSeconds: refreshTokenTtlSeconds,
		maxRooms: options.maxRooms ?? 10,
		trustProxy: options.trustProxy ?? false,
		snapshotDir: options.snapshotDir ?? null,
		now: now,
		nowIso: nowIso,
		log: options.log ?? (() => undefined),
		hashSecret: (kind, value) => hashSecret(options.secrets.tokenHash, kind, value),
		limit: (key, rule) => {
			const wait = limiter.consume(key, rule);
			if (wait !== null) {
				throw tooManyRequests(wait);
			}
		},
		checkFailures: (key, rule) => {
			const wait = limiter.blocked(key, rule);
			if (wait !== null) {
				throw tooManyRequests(wait);
			}
		}
	};
};
