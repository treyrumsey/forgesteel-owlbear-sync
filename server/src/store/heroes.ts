import { type JsonObject, hashOf } from '../json.ts';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';

export type RevisionSource = 'device' | 'import' | 'restore';

export interface HeroRow {
	room_id: string;
	id: string;
	seat_id: string;
	data: string;
	hash: string;
	rev: number;
	created_rev: number;
	updated_at: string;
	deleted_at: string | null;
}

export interface RevisionRow {
	rev: number;
	hash: string;
	source: RevisionSource;
	seat_id: string | null;
	device_id: string | null;
	sid: string | null;
	created_at: string;
}

export interface HeroWriter {
	seatId: string | null;
	deviceId: string | null;
	sid: string | null;
	source: RevisionSource;
}

export interface SaveHeroInput {
	roomId: string;
	id: string;
	ownerSeatId: string;
	// The hero without its _syncSteel stamp
	data: JsonObject;
	stampRev: number | null;
	writer: HeroWriter;
}

export interface SaveHeroResult {
	changed: boolean;
	rev: number;
	// The live revision before this save: 0 for a new or re-created hero
	previousRev: number;
	stampRev: number | null;
	sessionRev: number | null;
	// What Phase 3's three-way merge will use: the later of the stamp and the session's own last write
	baseRev: number | null;
	warning: string | null;
}

export interface Retention {
	// Always keep this many of each hero's latest revisions
	keepLast: number;
	// Beyond those, keep each day's last revision for this many days
	dailyDays: number;
	// Forget a session's last write after this long; its refresh token has expired by then
	sessionDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const createHeroStore = (db: DatabaseSync, now: () => number, retention: Retention) => {
	const iso = (ms: number) => new Date(ms).toISOString();

	const sql = {
		get: db.prepare('SELECT * FROM heroes WHERE room_id = ? AND id = ?'),
		listRoom: db.prepare('SELECT * FROM heroes WHERE room_id = ? AND deleted_at IS NULL ORDER BY rowid'),
		listSeat: db.prepare('SELECT * FROM heroes WHERE room_id = ? AND seat_id = ? AND deleted_at IS NULL ORDER BY rowid'),
		listDeleted: db.prepare('SELECT * FROM heroes WHERE room_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
		listAll: db.prepare('SELECT * FROM heroes WHERE room_id = ? ORDER BY rowid'),
		upsert: db.prepare(`
			INSERT INTO heroes (room_id, id, seat_id, data, hash, rev, created_rev, updated_at, deleted_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (room_id, id) DO UPDATE SET
				seat_id = excluded.seat_id, data = excluded.data, hash = excluded.hash, rev = excluded.rev,
				created_rev = excluded.created_rev, updated_at = excluded.updated_at, deleted_at = NULL`),
		softDelete: db.prepare('UPDATE heroes SET deleted_at = ?, updated_at = ? WHERE room_id = ? AND id = ? AND deleted_at IS NULL'),
		insertRevision: db.prepare(`
			INSERT INTO hero_revisions (room_id, hero_id, rev, data, hash, source, seat_id, device_id, sid, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		listRevisions: db.prepare('SELECT rev, hash, source, seat_id, device_id, sid, created_at FROM hero_revisions WHERE room_id = ? AND hero_id = ? ORDER BY rev DESC'),
		getRevision: db.prepare('SELECT data FROM hero_revisions WHERE room_id = ? AND hero_id = ? AND rev = ?'),
		pruneRevisions: db.prepare(`
			DELETE FROM hero_revisions AS r
			WHERE r.room_id = :room AND r.hero_id = :hero AND r.rev <= :latest - :keepLast
			AND NOT (
				r.created_at >= :cutoff
				AND r.rev = (
					SELECT MAX(d.rev) FROM hero_revisions AS d
					WHERE d.room_id = r.room_id AND d.hero_id = r.hero_id AND substr(d.created_at, 1, 10) = substr(r.created_at, 1, 10)
				)
			)`),
		getSessionWrite: db.prepare('SELECT rev FROM hero_session_writes WHERE room_id = ? AND hero_id = ? AND sid = ?'),
		putSessionWrite: db.prepare(`
			INSERT INTO hero_session_writes (room_id, hero_id, sid, rev, updated_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (room_id, hero_id, sid) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at`),
		pruneSessionWrites: db.prepare('DELETE FROM hero_session_writes WHERE room_id = ? AND hero_id = ? AND updated_at < ?'),
		clearSessionWrites: db.prepare('DELETE FROM hero_session_writes WHERE room_id = ? AND hero_id = ?')
	};

	const get = (roomId: string, id: string) => sql.get.get(roomId, id) as HeroRow | undefined;

	const describeBase = (live: HeroRow | undefined, existing: HeroRow | undefined, baseRev: number | null) => {
		if (!live && existing) {
			return 're-creates a deleted hero';
		}
		if (!live) {
			return null;
		}
		if (baseRev === null) {
			return 'no base for an update';
		}
		if (baseRev < live.created_rev) {
			return `base predates this hero's re-creation at rev ${live.created_rev}`;
		}
		if (baseRev < live.rev) {
			return `stale base (current was rev ${live.rev})`;
		}
		return null;
	};

	// Phase 1 is last writer wins. Phase 3 adds the three-way merge against baseRev (report §4.4).
	const save = (input: SaveHeroInput): SaveHeroResult => transaction(db, () => {
		const nowMs = now();
		const timestamp = iso(nowMs);
		const { roomId, id, writer } = input;
		const existing = get(roomId, id);
		const live = (existing && (existing.deleted_at === null)) ? existing : undefined;
		const sessionRow = writer.sid ? sql.getSessionWrite.get(roomId, id, writer.sid) as { rev: number } | undefined : undefined;
		const sessionRev = sessionRow ? sessionRow.rev : null;
		const candidates = [ input.stampRev, sessionRev ].filter(rev => rev !== null);
		const baseRev = candidates.length > 0 ? Math.max(...candidates) : null;
		const hash = hashOf(input.data);
		const bases = { stampRev: input.stampRev, sessionRev: sessionRev, baseRev: baseRev };

		if (live && (live.hash === hash)) {
			if (writer.sid) {
				sql.putSessionWrite.run(roomId, id, writer.sid, live.rev, timestamp);
			}
			return { changed: false, rev: live.rev, previousRev: live.rev, ...bases, warning: null };
		}

		const rev = (existing ? existing.rev : 0) + 1;
		const createdRev = live ? live.created_rev : rev;
		const json = JSON.stringify(input.data);
		sql.upsert.run(roomId, id, input.ownerSeatId, json, hash, rev, createdRev, timestamp);
		sql.insertRevision.run(roomId, id, rev, gzipSync(json), hash, writer.source, writer.seatId, writer.deviceId, writer.sid, timestamp);
		if (writer.sid) {
			sql.putSessionWrite.run(roomId, id, writer.sid, rev, timestamp);
		}

		sql.pruneRevisions.run({
			room: roomId,
			hero: id,
			latest: rev,
			keepLast: retention.keepLast,
			cutoff: iso(nowMs - (retention.dailyDays * DAY_MS))
		});
		sql.pruneSessionWrites.run(roomId, id, iso(nowMs - (retention.sessionDays * DAY_MS)));

		const warning = writer.source === 'device' ? describeBase(live, existing, baseRev) : null;
		return { changed: true, rev: rev, previousRev: live ? live.rev : 0, ...bases, warning: warning };
	});

	const getRevisionData = (roomId: string, heroId: string, rev: number) => {
		const row = sql.getRevision.get(roomId, heroId, rev) as { data: Uint8Array } | undefined;
		return row ? JSON.parse(gunzipSync(row.data).toString('utf8')) as JsonObject : undefined;
	};

	return {
		get: get,
		// Live heroes only; a null seat lists the whole room
		list: (roomId: string, seatId: string | null) => {
			return (seatId === null ? sql.listRoom.all(roomId) : sql.listSeat.all(roomId, seatId)) as unknown as HeroRow[];
		},
		listDeleted: (roomId: string) => sql.listDeleted.all(roomId) as unknown as HeroRow[],
		listAll: (roomId: string) => sql.listAll.all(roomId) as unknown as HeroRow[],
		save: save,
		// Soft delete: the row keeps its revision number, so re-creating the hero continues from it
		softDelete: (roomId: string, id: string) => transaction(db, () => {
			const timestamp = iso(now());
			const deleted = sql.softDelete.run(timestamp, timestamp, roomId, id).changes > 0;
			if (deleted) {
				sql.clearSessionWrites.run(roomId, id);
			}
			return deleted;
		}),
		listRevisions: (roomId: string, heroId: string) => sql.listRevisions.all(roomId, heroId) as unknown as RevisionRow[],
		getRevisionData: getRevisionData
	};
};

export type HeroStore = ReturnType<typeof createHeroStore>;
