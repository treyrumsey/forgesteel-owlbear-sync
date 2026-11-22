import { type JsonObject, hashOf, isObject } from './json.ts';
import type { Principal, Services } from './services.ts';
import type { SeatRow } from './store/rooms.ts';
import { fail } from './http.ts';
import { randomUUID } from 'node:crypto';
import { transaction } from './db/database.ts';

// The GM's off-Railway copy of a room (report §6). Device tokens and secrets are never included:
// after a restore into a new room, players join again with its code.

export const EXPORT_FORMAT = 'sync-steel-room-export';
export const EXPORT_VERSION = 1;

export interface ExportedSeat {
	id: string;
	name: string;
	isGm: boolean;
	session: unknown;
	hiddenSettingIds: unknown;
}

export interface ExportedHero {
	id: string;
	seatId: string;
	rev: number;
	updatedAt: string;
	deleted: boolean;
	data: JsonObject;
}

export interface ExportedHomebrew {
	id: string;
	rev: number;
	updatedAt: string;
	deleted: boolean;
	data: JsonObject;
}

export interface RoomExport {
	format: typeof EXPORT_FORMAT;
	version: typeof EXPORT_VERSION;
	exportedAt: string;
	room: { id: string, name: string };
	seats: ExportedSeat[];
	heroes: ExportedHero[];
	homebrew: ExportedHomebrew[];
}

interface Tally {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
}

export interface ImportSummary {
	seats: { matched: number, created: number };
	seatData: { updated: number };
	heroes: Tally;
	homebrew: Tally;
}

export const buildRoomExport = (s: Services, roomId: string): RoomExport => {
	const room = s.rooms.getRoom(roomId);
	if (!room) {
		throw fail(404, 'Not found');
	}
	return {
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		exportedAt: s.nowIso(),
		room: { id: room.id, name: room.name },
		seats: s.rooms.listSeats(roomId).map(seat => ({
			id: seat.id,
			name: seat.name,
			isGm: seat.is_gm === 1,
			session: s.seatData.get(seat.id, 'session'),
			hiddenSettingIds: s.seatData.get(seat.id, 'hidden-setting-ids')
		})),
		heroes: s.heroes.listAll(roomId).map(row => ({
			id: row.id,
			seatId: row.seat_id,
			rev: row.rev,
			updatedAt: row.updated_at,
			deleted: row.deleted_at !== null,
			data: JSON.parse(row.data) as JsonObject
		})),
		homebrew: s.homebrew.listAll(roomId).map(row => ({
			id: row.id,
			rev: row.rev,
			updatedAt: row.updated_at,
			deleted: row.deleted_at !== null,
			data: JSON.parse(row.data) as JsonObject
		}))
	};
};

const invalid = (problem: string) => fail(400, `This isn't a valid Sync Steel room export: ${problem}`);

const isEntry = (value: unknown): value is { id: string, data: JsonObject } => {
	return isObject(value) && (typeof value.id === 'string') && isObject(value.data) && (value.data.id === value.id);
};

export const parseRoomExport = (value: unknown): RoomExport => {
	if (!isObject(value) || (value.format !== EXPORT_FORMAT)) {
		throw invalid('unknown format');
	}
	if (value.version !== EXPORT_VERSION) {
		throw invalid(`version ${String(value.version)} isn't supported`);
	}
	if (!Array.isArray(value.seats) || !Array.isArray(value.heroes) || !Array.isArray(value.homebrew)) {
		throw invalid('missing seats, heroes or homebrew');
	}
	if (!value.seats.every(seat => isObject(seat) && (typeof seat.id === 'string') && (typeof seat.name === 'string') && (seat.name.trim().length > 0))) {
		throw invalid('a seat has no id or name');
	}
	if (!value.heroes.every(hero => isEntry(hero) && (typeof (hero as JsonObject).seatId === 'string'))) {
		throw invalid('a hero has no id, seat or data, or its data has a different id');
	}
	if (!value.homebrew.every(isEntry)) {
		throw invalid('a homebrew sourcebook has no id or data, or its data has a different id');
	}
	return value as unknown as RoomExport;
};

const DRY_RUN = Symbol('dry run');

// Upserts everything as new revisions and never deletes anything. A dry run does the same work and rolls it back.
export const importRoom = (s: Services, principal: Principal, payload: RoomExport, dryRun: boolean): ImportSummary => {
	const roomId = principal.roomId;
	const changedHeroes: { heroId: string, seatId: string, rev: number }[] = [];

	const run = (): ImportSummary => {
		const summary: ImportSummary = {
			seats: { matched: 0, created: 0 },
			seatData: { updated: 0 },
			heroes: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
			homebrew: { created: 0, updated: 0, unchanged: 0, skipped: 0 }
		};

		const seats = new Map<string, SeatRow>();
		payload.seats.forEach(exported => {
			const byId = s.rooms.getSeat(exported.id);
			let seat = (byId && (byId.room_id === roomId)) ? byId : undefined;
			seat ??= s.rooms.findSeatByName(roomId, exported.name.trim());
			seat ??= exported.isGm ? s.rooms.getGmSeat(roomId) : undefined;
			if (seat) {
				summary.seats.matched += 1;
			} else {
				const id = byId ? randomUUID() : exported.id;
				s.rooms.createSeat({ id: id, roomId: roomId, name: exported.name.trim(), isGm: false });
				seat = s.rooms.getSeat(id) as SeatRow;
				summary.seats.created += 1;
			}
			seats.set(exported.id, seat);

			const values = [ [ 'session', exported.session ], [ 'hidden-setting-ids', exported.hiddenSettingIds ] ] as const;
			values.forEach(([ key, value ]) => {
				if ((value !== null) && (value !== undefined) && (hashOf(value) !== hashOf(s.seatData.get((seat as SeatRow).id, key)))) {
					s.seatData.put((seat as SeatRow).id, key, value);
					summary.seatData.updated += 1;
				}
			});
		});

		const gmSeat = s.rooms.getGmSeat(roomId) as SeatRow;
		const writer = { seatId: principal.seatId, deviceId: principal.deviceId, sid: null, source: 'import' as const };
		payload.heroes.forEach(hero => {
			const owner = seats.get(hero.seatId) ?? gmSeat;
			const existing = s.heroes.get(roomId, hero.id);
			if (hero.deleted) {
				if (existing) {
					summary.heroes.skipped += 1;
				} else {
					s.heroes.save({ roomId: roomId, id: hero.id, ownerSeatId: owner.id, data: hero.data, stampRev: null, writer: writer });
					s.heroes.softDelete(roomId, hero.id);
					summary.heroes.created += 1;
				}
				return;
			}

			const result = s.heroes.save({ roomId: roomId, id: hero.id, ownerSeatId: existing ? existing.seat_id : owner.id, data: hero.data, stampRev: null, writer: writer });
			if (!result.changed) {
				summary.heroes.unchanged += 1;
			} else {
				summary.heroes[(existing && (existing.deleted_at === null)) ? 'updated' : 'created'] += 1;
				changedHeroes.push({ heroId: hero.id, seatId: existing ? existing.seat_id : owner.id, rev: result.rev });
			}
		});

		payload.homebrew.forEach(sourcebook => {
			const existing = s.homebrew.get(roomId, sourcebook.id);
			if (sourcebook.deleted) {
				if (existing) {
					summary.homebrew.skipped += 1;
				} else {
					s.homebrew.save(roomId, sourcebook.id, sourcebook.data, principal.seatId);
					s.homebrew.softDelete(roomId, sourcebook.id);
					summary.homebrew.created += 1;
				}
				return;
			}
			const result = s.homebrew.save(roomId, sourcebook.id, sourcebook.data, principal.seatId);
			if (!result.changed) {
				summary.homebrew.unchanged += 1;
			} else {
				summary.homebrew[(existing && (existing.deleted_at === null)) ? 'updated' : 'created'] += 1;
			}
		});

		if (!dryRun) {
			s.rooms.audit({ roomId: roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'room.imported', detail: { from: payload.room, exportedAt: payload.exportedAt, summary: summary } });
		}
		return summary;
	};

	if (!dryRun) {
		const summary = transaction(s.db, run);
		changedHeroes.forEach(hero => s.events.emit({ type: 'hero.changed', roomId: roomId, ...hero, sid: null, source: 'import' }));
		return summary;
	}

	let summary: ImportSummary | undefined;
	try {
		transaction(s.db, () => {
			summary = run();
			throw DRY_RUN;
		});
	} catch (error) {
		if (error !== DRY_RUN) {
			throw error;
		}
	}
	return summary as ImportSummary;
};
