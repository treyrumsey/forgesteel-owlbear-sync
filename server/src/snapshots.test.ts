import { createSnapshotter, listSnapshots } from './snapshots.ts';
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServices } from './services.ts';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { migrate } from './db/migrate.ts';
import { openDatabase } from './db/database.ts';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const DAY = 24 * 60 * 60 * 1000;

const setup = () => {
	const dir = mkdtempSync(join(tmpdir(), 'sync-steel-snapshots-'));
	const db = openDatabase(join(dir, 'live.db'));
	migrate(db);
	const clock = { now: Date.parse('2026-11-22T12:00:00Z') };
	const s = createServices({ db: db, secrets: { jwt: 'a', jwtRefresh: 'b', tokenHash: 'c' }, now: () => clock.now });
	s.rooms.createRoom({ id: 'room', name: 'Thursday group', joinCodeHash: 'code', gmKeyHash: 'key' });
	s.rooms.createSeat({ id: 'gm', roomId: 'room', name: 'GM', isGm: true });
	const saveKalla = (damage: number) => s.heroes.save({
		roomId: 'room',
		id: 'kalla',
		ownerSeatId: 'gm',
		data: { id: 'kalla', name: 'Kalla', state: { staminaDamage: damage } },
		stampRev: null,
		writer: { seatId: 'gm', deviceId: null, sid: null, source: 'device' }
	});
	const snapshots = createSnapshotter({ db: db, dir: join(dir, 'snapshots'), keep: 2, now: () => clock.now });
	return { dir: dir, db: db, clock: clock, saveKalla: saveKalla, snapshots: snapshots };
};

describe('database snapshots', () => {
	it('take one copy per day and keep only the newest', () => {
		const { clock, snapshots } = setup();

		const first = snapshots.snapshotIfDue();
		const sameDay = snapshots.snapshotIfDue();
		clock.now += DAY;
		snapshots.snapshotIfDue();
		clock.now += DAY;
		const third = snapshots.snapshotIfDue();

		expect(first).toMatch(/sync-steel-2026-11-22\.db$/);
		expect(sameDay).toBeNull();
		expect(existsSync(first as string)).toBe(false);
		expect(third).toMatch(/sync-steel-2026-11-24\.db$/);
	});

	it('never keep a failed or interrupted copy as the day\'s snapshot, so the next check retries', () => {
		const { dir, db, snapshots } = setup();
		const snapshotDir = join(dir, 'snapshots');
		mkdirSync(snapshotDir, { recursive: true });
		// What a copy killed mid-write leaves behind
		writeFileSync(join(snapshotDir, 'sync-steel-2026-11-22.db.partial'), 'half a database');

		// SQLite refuses VACUUM inside a transaction, standing in for a disk error
		db.exec('BEGIN');
		expect(() => snapshots.snapshotIfDue()).toThrow();
		db.exec('ROLLBACK');
		expect(listSnapshots(snapshotDir)).toEqual([]);

		const retried = snapshots.snapshotIfDue();

		expect(retried).toMatch(/sync-steel-2026-11-22\.db$/);
		expect(readdirSync(snapshotDir)).toEqual([ 'sync-steel-2026-11-22.db' ]);
	});

	// The restore path: snapshot -> export-room.ts -> the GM's import endpoint
	it('can be turned into a room export that shows the data as it was', () => {
		const { saveKalla, snapshots } = setup();
		saveKalla(5);
		const snapshot = snapshots.snapshotIfDue() as string;
		saveKalla(40);

		const result = spawnSync(process.execPath, [ 'src/tools/export-room.ts', snapshot, 'thursday group', '--base64' ], {
			cwd: new URL('..', import.meta.url),
			encoding: 'utf8'
		});
		const payload = JSON.parse(gunzipSync(Buffer.from(result.stdout, 'base64')).toString('utf8'));

		expect(result.status).toBe(0);
		expect(result.stderr).toContain('Exported room "Thursday group": 1 seats, 1 heroes, 0 homebrew');
		expect(payload).toMatchObject({ format: 'sync-steel-room-export', room: { name: 'Thursday group' } });
		expect(payload.heroes[0].data.state).toEqual({ staminaDamage: 5 });
	});
});
