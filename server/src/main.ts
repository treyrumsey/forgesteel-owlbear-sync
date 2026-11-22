import { parseDeviceTokens, parseList } from './config.ts';
import type { AddressInfo } from 'node:net';
import { createStubServer } from './stub-server.ts';
import { randomBytes } from 'node:crypto';

// Run with: node src/main.ts (Node 26 runs TypeScript directly)

const DEFAULT_CORS_ORIGINS = [
	// The fork's Vite dev server (npm start)
	'http://localhost:5173',
	'http://127.0.0.1:5173',
	// Unmodified forgesteel.net, via Settings > Warehouse
	'https://forgesteel.net'
];

const writeLine = (line: string) => {
	process.stdout.write(`${line}\n`);
};

const env = process.env;
let deviceTokens: Record<string, string>;
try {
	deviceTokens = parseDeviceTokens(env.STUB_DEVICE_TOKENS ?? 'dev-token=Dev');
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
const corsOrigins = env.CORS_ORIGINS ? parseList(env.CORS_ORIGINS) : DEFAULT_CORS_ORIGINS;

const server = createStubServer({
	deviceTokens: deviceTokens,
	corsOrigins: corsOrigins,
	// A random secret means tokens issued before a restart stop working; devices just reconnect
	jwtSecret: env.JWT_SECRET ?? randomBytes(32).toString('hex'),
	accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS ? Number(env.ACCESS_TOKEN_TTL_SECONDS) : undefined,
	log: writeLine
});

server.listen(Number(env.PORT ?? 8787), () => {
	const address = server.address() as AddressInfo;
	writeLine(`Table Link stub Warehouse listening on http://localhost:${address.port}`);
	writeLine(`Seats: ${[ ...new Set(Object.values(deviceTokens)) ].join(', ')} (${Object.keys(deviceTokens).length} device tokens)`);
	writeLine(`CORS origins: ${corsOrigins.join(', ')}`);
});

const shutdown = () => {
	server.close(() => process.exit(0));
	server.closeAllConnections();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
