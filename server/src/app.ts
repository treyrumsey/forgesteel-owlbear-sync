import { type AppEnv, type ServiceOptions, createServices } from './services.ts';
import { HttpError, clientIp } from './http.ts';
import { type HubOptions, MAX_HELLO_BYTES, createHub } from './hub.ts';
import { serve, upgradeWebSocket } from '@hono/node-server';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { Hono } from 'hono';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { authRoutes } from './routes/auth.ts';
import { gmRoutes } from './routes/gm.ts';
import { roomRoutes } from './routes/rooms.ts';
import { warehouseRoutes } from './routes/warehouse.ts';

// Forge Steel adds X-NO-RETRY when it retries a request after refreshing an expired token
const ALLOWED_HEADERS = 'Authorization, Content-Type, X-CSRF-TOKEN, X-NO-RETRY';
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

export interface AppOptions extends ServiceOptions {
	corsOrigins: string[];
	hub?: Partial<HubOptions>;
}

export const createApp = (options: AppOptions) => {
	const services = createServices(options);
	const hub = createHub(services, options.hub);
	const app = new Hono<AppEnv>();

	app.use('*', async (c, next) => {
		await next();
		const url = new URL(c.req.url);
		services.log(`${services.nowIso()} ${c.req.header('origin') ?? '-'} ${c.req.method} ${url.pathname}${url.search} ${c.res.status}`);
	});

	// Credentialed requests (Forge Steel's connection test) need the exact origin, never '*'
	app.use('*', async (c, next) => {
		const origin = c.req.header('origin');
		const allowed = (origin !== undefined) && options.corsOrigins.includes(origin);
		if (c.req.method === 'OPTIONS') {
			if (!allowed) {
				return c.body(null, 403);
			}
			c.header('Access-Control-Allow-Origin', origin);
			c.header('Access-Control-Allow-Credentials', 'true');
			c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
			c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
			c.header('Access-Control-Max-Age', '600');
			c.header('Vary', 'Origin');
			if (c.req.header('access-control-request-private-network') === 'true') {
				c.header('Access-Control-Allow-Private-Network', 'true');
			}
			return c.body(null, 204);
		}

		await next();
		if (allowed) {
			c.res.headers.set('Access-Control-Allow-Origin', origin);
			c.res.headers.set('Access-Control-Allow-Credentials', 'true');
			c.res.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Retry-After');
			c.res.headers.append('Vary', 'Origin');
		}
	});

	// Live sync (hub.ts). Browsers send Origin on a WebSocket upgrade, and CORS doesn't apply to it, so check it here.
	app.get(
		'/live',
		async (c, next) => {
			if (!options.corsOrigins.includes(c.req.header('origin') ?? '')) {
				return c.json({ message: 'Origin not allowed' }, 403);
			}
			await next();
		},
		upgradeWebSocket(c => hub.events(clientIp(c, services.trustProxy))),
		c => c.json({ message: 'Expected a WebSocket upgrade' }, 426)
	);

	app.route('/', authRoutes(services));
	app.route('/', roomRoutes(services));
	app.route('/', warehouseRoutes(services));
	app.route('/', gmRoutes(services));

	app.notFound(c => c.json({ message: 'Not found' }, 404));

	app.onError((error, c) => {
		if (error instanceof HttpError) {
			const status = error.status as ContentfulStatusCode;
			return (typeof error.body === 'string') ? c.text(error.body, status, error.headers) : c.json(error.body, status, error.headers);
		}
		if (error instanceof HTTPException) {
			return error.getResponse();
		}
		services.log(`  error: ${error instanceof Error ? error.stack : String(error)}`);
		return c.json({ message: 'Internal server error' }, 500);
	});

	return { app: app, services: services, hub: hub };
};

// Resolves once the server is listening; port 0 picks a free port
export const listen = (app: Hono<AppEnv>, port: number, hostname?: string) => {
	return new Promise<{ server: Server, port: number }>(resolve => {
		const server = serve({
			fetch: app.fetch,
			port: port,
			hostname: hostname,
			// Keep the standard Request and Response globals, which tests and other code share
			overrideGlobalObjects: false,
			websocket: { server: new WebSocketServer({ noServer: true, maxPayload: MAX_HELLO_BYTES }) }
		}, info => resolve({ server: server as Server, port: info.port }));
	});
};
