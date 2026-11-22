import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

// One process owns the database file, so the synchronous API never interleaves requests mid-transaction
export const openDatabase = (path: string): DatabaseSync => {
	if (path !== ':memory:') {
		mkdirSync(dirname(path), { recursive: true });
	}

	const db = new DatabaseSync(path);
	db.exec('PRAGMA journal_mode = WAL');
	// Durability over speed: a hero save is only acknowledged once it's on the volume
	db.exec('PRAGMA synchronous = FULL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec('PRAGMA busy_timeout = 5000');
	return db;
};

export const transaction = <T>(db: DatabaseSync, work: () => T): T => {
	if (db.isTransaction) {
		return work();
	}

	db.exec('BEGIN IMMEDIATE');
	try {
		const result = work();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
};
