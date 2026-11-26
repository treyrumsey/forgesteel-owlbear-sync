import type { DatabaseSync } from 'node:sqlite';

export interface RoomRow {
	id: string;
	name: string;
	join_code_hash: string;
	gm_key_hash: string;
	created_at: string;
	code_rotated_at: string;
	last_export_at: string | null;
}

export interface SeatRow {
	id: string;
	room_id: string;
	name: string;
	is_gm: number;
	created_at: string;
}

export interface DeviceRow {
	id: string;
	seat_id: string;
	token_hash: string;
	label: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
	kind: DeviceKind;
}

// An Owlbear token is a device in the GM seat that only receives hero summaries (migration 003)
export type DeviceKind = 'device' | 'owlbear';

export interface AuditRow {
	id: number;
	at: string;
	seat_id: string | null;
	device_id: string | null;
	action: string;
	detail: string | null;
}

export interface AuditEntry {
	roomId: string;
	seatId?: string | null;
	deviceId?: string | null;
	action: string;
	detail?: unknown;
}

// Rooms, seats, devices and the audit log
export const createRoomStore = (db: DatabaseSync, nowIso: () => string) => {
	const sql = {
		countRooms: db.prepare('SELECT COUNT(*) AS count FROM rooms'),
		insertRoom: db.prepare('INSERT INTO rooms (id, name, join_code_hash, gm_key_hash, created_at, code_rotated_at) VALUES (?, ?, ?, ?, ?, ?)'),
		getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
		findRoomByName: db.prepare('SELECT * FROM rooms WHERE name = ? ORDER BY created_at LIMIT 1'),
		findRoomByJoinCode: db.prepare('SELECT * FROM rooms WHERE join_code_hash = ?'),
		findRoomByGmKey: db.prepare('SELECT * FROM rooms WHERE gm_key_hash = ?'),
		setJoinCode: db.prepare('UPDATE rooms SET join_code_hash = ?, code_rotated_at = ? WHERE id = ?'),
		setLastExport: db.prepare('UPDATE rooms SET last_export_at = ? WHERE id = ?'),
		insertSeat: db.prepare('INSERT INTO seats (id, room_id, name, is_gm, created_at) VALUES (?, ?, ?, ?, ?)'),
		getSeat: db.prepare('SELECT * FROM seats WHERE id = ?'),
		listSeats: db.prepare('SELECT * FROM seats WHERE room_id = ? ORDER BY is_gm DESC, name COLLATE NOCASE'),
		findSeatByName: db.prepare('SELECT * FROM seats WHERE room_id = ? AND name = ? COLLATE NOCASE'),
		getGmSeat: db.prepare('SELECT * FROM seats WHERE room_id = ? AND is_gm = 1'),
		renameSeat: db.prepare('UPDATE seats SET name = ? WHERE id = ?'),
		insertDevice: db.prepare('INSERT INTO devices (id, seat_id, token_hash, label, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)'),
		getDevice: db.prepare('SELECT * FROM devices WHERE id = ?'),
		findDeviceByToken: db.prepare('SELECT * FROM devices WHERE token_hash = ?'),
		listDevices: db.prepare('SELECT devices.* FROM devices JOIN seats ON seats.id = devices.seat_id WHERE seats.room_id = ? ORDER BY devices.created_at'),
		touchDevice: db.prepare('UPDATE devices SET last_used_at = ? WHERE id = ?'),
		revokeDevice: db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
		insertAudit: db.prepare('INSERT INTO audit_log (room_id, at, seat_id, device_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)'),
		listAudit: db.prepare('SELECT id, at, seat_id, device_id, action, detail FROM audit_log WHERE room_id = ? ORDER BY id DESC LIMIT ?')
	};

	return {
		countRooms: () => (sql.countRooms.get() as { count: number }).count,
		createRoom: (room: { id: string, name: string, joinCodeHash: string, gmKeyHash: string }) => {
			const now = nowIso();
			sql.insertRoom.run(room.id, room.name, room.joinCodeHash, room.gmKeyHash, now, now);
		},
		getRoom: (id: string) => sql.getRoom.get(id) as RoomRow | undefined,
		findRoomByName: (name: string) => sql.findRoomByName.get(name) as RoomRow | undefined,
		findRoomByJoinCodeHash: (hash: string) => sql.findRoomByJoinCode.get(hash) as RoomRow | undefined,
		findRoomByGmKeyHash: (hash: string) => sql.findRoomByGmKey.get(hash) as RoomRow | undefined,
		setJoinCodeHash: (roomId: string, hash: string) => {
			sql.setJoinCode.run(hash, nowIso(), roomId);
		},
		markExported: (roomId: string) => {
			sql.setLastExport.run(nowIso(), roomId);
		},

		createSeat: (seat: { id: string, roomId: string, name: string, isGm: boolean }) => {
			sql.insertSeat.run(seat.id, seat.roomId, seat.name, seat.isGm ? 1 : 0, nowIso());
		},
		getSeat: (id: string) => sql.getSeat.get(id) as SeatRow | undefined,
		listSeats: (roomId: string) => sql.listSeats.all(roomId) as unknown as SeatRow[],
		findSeatByName: (roomId: string, name: string) => sql.findSeatByName.get(roomId, name) as SeatRow | undefined,
		getGmSeat: (roomId: string) => sql.getGmSeat.get(roomId) as SeatRow | undefined,
		renameSeat: (id: string, name: string) => {
			sql.renameSeat.run(name, id);
		},

		createDevice: (device: { id: string, seatId: string, tokenHash: string, label: string, kind?: DeviceKind }) => {
			sql.insertDevice.run(device.id, device.seatId, device.tokenHash, device.label, nowIso(), device.kind ?? 'device');
		},
		getDevice: (id: string) => sql.getDevice.get(id) as DeviceRow | undefined,
		findDeviceByTokenHash: (hash: string) => sql.findDeviceByToken.get(hash) as DeviceRow | undefined,
		listDevices: (roomId: string) => sql.listDevices.all(roomId) as unknown as DeviceRow[],
		touchDevice: (id: string) => {
			sql.touchDevice.run(nowIso(), id);
		},
		revokeDevice: (id: string) => sql.revokeDevice.run(nowIso(), id).changes > 0,

		audit: (entry: AuditEntry) => {
			const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail);
			sql.insertAudit.run(entry.roomId, nowIso(), entry.seatId ?? null, entry.deviceId ?? null, entry.action, detail);
		},
		listAudit: (roomId: string, limit: number) => sql.listAudit.all(roomId, limit) as unknown as AuditRow[]
	};
};

export type RoomStore = ReturnType<typeof createRoomStore>;
