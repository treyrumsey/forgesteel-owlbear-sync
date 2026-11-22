import type { DatabaseSync } from 'node:sqlite';

export type SeatDataKey = 'session' | 'hidden-setting-ids';

// Each seat's own Forge Steel session and hidden sourcebook ids
export const createSeatDataStore = (db: DatabaseSync, nowIso: () => string) => {
	const sql = {
		get: db.prepare('SELECT data FROM seat_data WHERE seat_id = ? AND key = ?'),
		put: db.prepare(`
			INSERT INTO seat_data (seat_id, key, data, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (seat_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
	};

	return {
		get: (seatId: string, key: SeatDataKey): unknown => {
			const row = sql.get.get(seatId, key) as { data: string } | undefined;
			return row ? JSON.parse(row.data) as unknown : null;
		},
		put: (seatId: string, key: SeatDataKey, value: unknown) => {
			sql.put.run(seatId, key, JSON.stringify(value ?? null), nowIso());
		}
	};
};

export type SeatDataStore = ReturnType<typeof createSeatDataStore>;
