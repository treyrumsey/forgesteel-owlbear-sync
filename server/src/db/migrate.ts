import { readFileSync, readdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.ts';

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

// Files are named like 001-initial.sql; the number is the schema version they produce
export const loadMigrations = (dir: URL = MIGRATIONS_DIR): Migration[] => {
	const migrations = readdirSync(dir)
		.filter(name => /^\d+-[\w-]+\.sql$/.test(name))
		.map(name => ({ version: parseInt(name, 10), name: name, sql: readFileSync(new URL(name, dir), 'utf8') }))
		.sort((a, b) => a.version - b.version);

	migrations.forEach((migration, index) => {
		if (migration.version !== index + 1) {
			throw new Error(`Migration ${migration.name} should be version ${index + 1}: versions must start at 1 with no gaps`);
		}
	});
	return migrations;
};

export const getSchemaVersion = (db: DatabaseSync) => {
	return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
};

// Applies each pending migration in its own transaction; user_version records the last one applied
export const migrate = (db: DatabaseSync, migrations: Migration[] = loadMigrations()): string[] => {
	const current = getSchemaVersion(db);
	const latest = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
	if (current > latest) {
		throw new Error(`The database is at schema version ${current}, which is newer than this server (version ${latest})`);
	}

	return migrations
		.filter(migration => migration.version > current)
		.map(migration => {
			transaction(db, () => {
				db.exec(migration.sql);
				db.exec(`PRAGMA user_version = ${migration.version}`);
			});
			return migration.name;
		});
};
