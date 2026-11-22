import { type AppEnv, type ServiceOptions, createServices } from './services.ts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { Hono } from 'hono';
import { HttpError } from './http.ts';
import type { Server } from 'node:http';
import { authRoutes } from './routes/auth.ts';
import { gmRoutes } from './routes/gm.ts';
import { roomRoutes } from './routes/rooms.ts';
import { serve } from '@hono/node-server';
import { warehouseRoutes } from './routes/warehouse.ts';

// Forge Steel adds X-NO-RETRY when it retries a request after refreshing an expired token
const ALLOWED_HEADERS = 'Authorization, Content-Type, X-CSRF-TOKEN, X-NO-RETRY';
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

export interface AppOptions extends ServiceOptions {
	corsOrigins: string[];
}

export const createApp = (options: AppOptions) => {
	const services = createServices(options);
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

	return { app: app, services: services };
};

// Resolves once the server is listening; port 0 picks a free port
export const listen = (app: Hono<AppEnv>, port: number, hostname?: string) => {
	return new Promise<{ server: Server, port: number }>(resolve => {
		const server = serve({
			fetch: app.fetch,
			port: port,
			hostname: hostname,
			// Keep the standard Request and Response globals, which tests and other code share
			overrideGlobalObjects: false
		}, info => resolve({ server: server as Server, port: info.port }));
	});
};
