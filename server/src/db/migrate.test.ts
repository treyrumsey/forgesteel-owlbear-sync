import { describe, expect, it } from 'vitest';
import { getSchemaVersion, loadMigrations, migrate } from './migrate.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from './database.ts';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

describe('migrate', () => {
	it('applies every migration to a new database once', () => {
		const db = openDatabase(':memory:');

		const first = migrate(db);
		const second = migrate(db);

		expect(first).toEqual(loadMigrations().map(migration => migration.name));
		expect(second).toEqual([]);
		expect(getSchemaVersion(db)).toBe(loadMigrations().length);
	});

	it('refuses a database from a newer server', () => {
		const db = openDatabase(':memory:');
		db.exec('PRAGMA user_version = 999');

		expect(() => migrate(db)).toThrow('newer than this server');
	});

	it('rolls back a failing migration and leaves the version unchanged', () => {
		const db = openDatabase(':memory:');
		const migrations = [
			{ version: 1, name: '001-good.sql', sql: 'CREATE TABLE a (id INTEGER) STRICT;' },
			{ version: 2, name: '002-bad.sql', sql: 'CREATE TABLE b (id INTEGER) STRICT; NOT SQL;' }
		];

		expect(() => migrate(db, migrations)).toThrow();
		expect(getSchemaVersion(db)).toBe(1);
		expect(db.prepare('SELECT name FROM sqlite_master WHERE name = \'b\'').get()).toBeUndefined();
	});

	it('requires migration numbers to start at 1 with no gaps', () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync-steel-migrations-'));
		writeFileSync(join(dir, '001-first.sql'), 'SELECT 1;');
		writeFileSync(join(dir, '003-third.sql'), 'SELECT 1;');

		expect(() => loadMigrations(pathToFileURL(`${dir}/`))).toThrow('should be version 2');
	});
});
