import { type AppOptions, createApp, listen } from './app.ts';
import { HeroSummaryLogic } from '@/sync-steel/logic/hero-summary-logic';
import { migrate } from './db/migrate.ts';
import { openDatabase } from './db/database.ts';
import { summaryToolsFrom } from './summary.ts';

// Shared by the server's tests: a real HTTP server on a free port, backed by an in-memory database

export const TEST_ORIGIN = 'http://localhost:5173';

export const startTestServer = async (options: Partial<AppOptions> = {}) => {
	const db = openDatabase(':memory:');
	migrate(db);
	const clock = { now: Date.parse('2026-11-22T12:00:00Z') };
	const logLines: string[] = [];
	const { app, services, hub } = createApp({
		db: db,
		corsOrigins: [ TEST_ORIGIN ],
		secrets: { jwt: 'test-jwt-secret', jwtRefresh: 'test-refresh-secret', tokenHash: 'test-token-hash-key' },
		now: () => clock.now,
		log: line => logLines.push(line),
		// The source, which Vitest can run; production loads the bundle (summary.ts)
		summaries: summaryToolsFrom({ HeroSummaryLogic: HeroSummaryLogic }),
		...options
	});
	const { server, port } = await listen(app, 0, '127.0.0.1');
	const base = `http://127.0.0.1:${port}`;

	const call = (path: string, token: string | null, init: RequestInit = {}) => {
		const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers as Record<string, string> };
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		return fetch(`${base}${path}`, { ...init, headers: headers });
	};

	const post = async (path: string, body: unknown, token: string | null = null) => {
		return call(path, token, { method: 'POST', body: JSON.stringify(body) });
	};

	const createRoom = async (roomName = 'The Table') => {
		const response = await post('/rooms', { roomName: roomName, gmSeatName: 'GM', deviceLabel: 'GM laptop' });
		if (response.status !== 201) {
			throw new Error(`POST /rooms ${response.status}: ${await response.text()}`);
		}
		return await response.json() as { room: { id: string, name: string }, seat: { id: string }, joinCode: string, gmKey: string, deviceToken: string };
	};

	const join = async (body: Record<string, unknown>) => {
		const response = await post('/join', { deviceLabel: 'Phone', ...body });
		if (response.status !== 201) {
			throw new Error(`POST /join ${response.status}: ${await response.text()}`);
		}
		return await response.json() as { seat: { id: string, name: string, isGm: boolean }, deviceToken: string };
	};

	const connect = async (deviceToken: string) => {
		const response = await call('/connect', deviceToken, { method: 'POST' });
		if (response.status !== 200) {
			throw new Error(`POST /connect ${response.status}: ${await response.text()}`);
		}
		return await response.json() as { access_token: string, refresh_token: string };
	};

	const putHero = (token: string, hero: { id: string } & Record<string, unknown>) => {
		return call(`/data/forgesteel-heroes/${hero.id}`, token, { method: 'PUT', body: JSON.stringify(hero) });
	};

	return {
		base: base,
		db: db,
		clock: clock,
		logLines: logLines,
		services: services,
		hub: hub,
		server: server,
		call: call,
		post: post,
		createRoom: createRoom,
		join: join,
		connect: connect,
		putHero: putHero,
		close: () => new Promise<void>(resolve => {
			hub.close();
			server.close(() => {
				db.close();
				resolve();
			});
			server.closeAllConnections();
		})
	};
};

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;
