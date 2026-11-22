import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

// Daily copies of the whole database on the same volume, for rolling back a bad change to everything.
// They don't survive losing the volume: the GM export is the copy outside Railway.

export interface SnapshotOptions {
	db: DatabaseSync;
	dir: string;
	keep: number;
	now?: () => number;
	log?: (line: string) => void;
}

const SNAPSHOT_FILE = /^sync-steel-(\d{4}-\d{2}-\d{2})\.db$/;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export const listSnapshots = (dir: string) => {
	try {
		return readdirSync(dir).filter(name => SNAPSHOT_FILE.test(name)).sort();
	} catch {
		return [];
	}
};

export const createSnapshotter = (options: SnapshotOptions) => {
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => undefined);

	// At most one snapshot per UTC day, named for that day; older ones beyond `keep` are removed
	const snapshotIfDue = () => {
		const name = `sync-steel-${new Date(now()).toISOString().slice(0, 10)}.db`;
		mkdirSync(options.dir, { recursive: true });
		if (listSnapshots(options.dir).includes(name)) {
			return null;
		}

		const path = join(options.dir, name);
		// VACUUM INTO writes a consistent, compacted copy while the database stays in use
		options.db.prepare('VACUUM INTO ?').run(path);
		const removed = listSnapshots(options.dir).slice(0, -options.keep);
		removed.forEach(old => rmSync(join(options.dir, old), { force: true }));
		log(`Snapshot ${path}${removed.length > 0 ? `; removed ${removed.join(', ')}` : ''}`);
		return path;
	};

	const run = () => {
		try {
			snapshotIfDue();
		} catch (error) {
			log(`  error: snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	return {
		snapshotIfDue: snapshotIfDue,
		start: () => {
			run();
			const timer = setInterval(run, CHECK_INTERVAL_MS);
			timer.unref();
			return () => clearInterval(timer);
		}
	};
};
