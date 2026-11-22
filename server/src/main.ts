import { createApp, listen } from './app.ts';
import { createSnapshotter } from './snapshots.ts';
import { loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { openDatabase } from './db/database.ts';
import { seedDevRoom } from './dev-seed.ts';

// Run with: node src/main.ts (Node 26 runs TypeScript directly)

const writeLine = (line: string) => {
	process.stdout.write(`${line}\n`);
};

const stop = (message: string) => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let loaded: ReturnType<typeof loadConfig>;
try {
	loaded = loadConfig(process.env);
} catch (error) {
	stop(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
	throw error;
}
const { config, warnings } = loaded;
warnings.forEach(warning => process.stderr.write(`Warning: ${warning}\n`));

const db = openDatabase(config.databasePath);
const applied = migrate(db);
writeLine(`Database ${config.databasePath}${applied.length > 0 ? `; applied ${applied.join(', ')}` : ''}`);

const { app, services } = createApp({
	db: db,
	corsOrigins: config.corsOrigins,
	secrets: { jwt: config.jwtSecret, jwtRefresh: config.jwtRefreshSecret, tokenHash: config.tokenHashKey },
	accessTokenTtlSeconds: config.accessTokenTtlSeconds,
	refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
	maxRooms: config.maxRooms,
	trustProxy: config.trustProxy,
	revisionKeepLast: config.revisionKeepLast,
	revisionDailyDays: config.revisionDailyDays,
	snapshotDir: config.snapshotDir,
	log: writeLine
});

if (config.devSeed) {
	seedDevRoom(services).forEach(writeLine);
}

const stopSnapshots = config.snapshotDir
	? createSnapshotter({ db: db, dir: config.snapshotDir, keep: config.snapshotKeep, log: writeLine }).start()
	: () => undefined;

const { server, port } = await listen(app, config.port);
writeLine(`Sync Steel server listening on http://localhost:${port}`);
writeLine(`CORS origins: ${config.corsOrigins.join(', ')}`);

const shutdown = () => {
	stopSnapshots();
	server.close(() => {
		db.close();
		process.exit(0);
	});
	server.closeAllConnections();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
