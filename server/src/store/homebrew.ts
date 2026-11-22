import { type JsonObject, hashOf } from '../json.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface HomebrewRow {
	room_id: string;
	id: string;
	data: string;
	hash: string;
	rev: number;
	updated_at: string;
	updated_by_seat: string | null;
	deleted_at: string | null;
}

// Homebrew sourcebooks are shared by the whole room: last writer wins, with soft delete
export const createHomebrewStore = (db: DatabaseSync, nowIso: () => string) => {
	const sql = {
		get: db.prepare('SELECT * FROM homebrew WHERE room_id = ? AND id = ?'),
		list: db.prepare('SELECT * FROM homebrew WHERE room_id = ? AND deleted_at IS NULL ORDER BY rowid'),
		listAll: db.prepare('SELECT * FROM homebrew WHERE room_id = ? ORDER BY rowid'),
		upsert: db.prepare(`
			INSERT INTO homebrew (room_id, id, data, hash, rev, updated_at, updated_by_seat, deleted_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (room_id, id) DO UPDATE SET
				data = excluded.data, hash = excluded.hash, rev = excluded.rev, updated_at = excluded.updated_at,
				updated_by_seat = excluded.updated_by_seat, deleted_at = NULL`),
		softDelete: db.prepare('UPDATE homebrew SET deleted_at = ?, updated_at = ? WHERE room_id = ? AND id = ? AND deleted_at IS NULL')
	};

	const get = (roomId: string, id: string) => sql.get.get(roomId, id) as HomebrewRow | undefined;

	return {
		get: get,
		list: (roomId: string) => sql.list.all(roomId) as unknown as HomebrewRow[],
		listAll: (roomId: string) => sql.listAll.all(roomId) as unknown as HomebrewRow[],
		save: (roomId: string, id: string, data: JsonObject, seatId: string | null) => {
			const existing = get(roomId, id);
			const hash = hashOf(data);
			if (existing && (existing.deleted_at === null) && (existing.hash === hash)) {
				return { changed: false, rev: existing.rev };
			}
			const rev = (existing ? existing.rev : 0) + 1;
			sql.upsert.run(roomId, id, JSON.stringify(data), hash, rev, nowIso(), seatId);
			return { changed: true, rev: rev };
		},
		softDelete: (roomId: string, id: string) => {
			const timestamp = nowIso();
			return sql.softDelete.run(timestamp, timestamp, roomId, id).changes > 0;
		}
	};
};

export type HomebrewStore = ReturnType<typeof createHomebrewStore>;
