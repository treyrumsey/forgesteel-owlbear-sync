import { type AppEnv, type Services } from '../services.ts';
import { HttpError, fail, readObject, requireName } from '../http.ts';
import { buildRoomExport, importRoom, parseRoomExport } from '../room-export.ts';
import { generateJoinCode, normalizeJoinCode } from '../secrets.ts';
import { gunzipSync, gzipSync } from 'node:zlib';
import { limitBody, stampHero } from './warehouse.ts';
import { requireDevice, requireGm } from './auth.ts';
import type { HeroRow } from '../store/heroes.ts';
import { Hono } from 'hono';
import type { JsonObject } from '../json.ts';

const MAX_IMPORT_JSON_BYTES = 200 * 1024 * 1024;

const heroName = (row: HeroRow) => {
	const name = (JSON.parse(row.data) as JsonObject).name;
	return typeof name === 'string' ? name : '';
};

const fileSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';

// Room management for devices in the GM seat. Phase 2's Sync Steel page in the fork is their UI.
export const gmRoutes = (s: Services) => {
	const app = new Hono<AppEnv>();
	app.use('/gm/*', requireDevice(s), requireGm);

	const findHero = (roomId: string, heroId: string) => {
		const row = s.heroes.get(roomId, heroId);
		if (!row) {
			throw fail(404, 'Not found');
		}
		return row;
	};

	app.get('/gm/room', c => {
		const principal = c.get('principal');
		const room = s.rooms.getRoom(principal.roomId);
		if (!room) {
			throw fail(404, 'Not found');
		}
		const devices = s.rooms.listDevices(room.id);
		const heroes = s.heroes.list(room.id, null);
		return c.json({
			room: { id: room.id, name: room.name, createdAt: room.created_at, codeRotatedAt: room.code_rotated_at, lastExportAt: room.last_export_at },
			seats: s.rooms.listSeats(room.id).map(seat => ({
				id: seat.id,
				name: seat.name,
				isGm: seat.is_gm === 1,
				createdAt: seat.created_at,
				devices: devices.filter(device => device.seat_id === seat.id).map(device => ({
					id: device.id,
					label: device.label,
					createdAt: device.created_at,
					lastUsedAt: device.last_used_at,
					revokedAt: device.revoked_at,
					current: device.id === principal.deviceId
				})),
				heroes: heroes.filter(hero => hero.seat_id === seat.id).map(hero => ({ id: hero.id, name: heroName(hero), rev: hero.rev, updatedAt: hero.updated_at }))
			}))
		});
	});

	// The code is stored only as a hash, so the GM sees it when the room is created and each time it's rotated.
	// Rotating doesn't sign out devices that already joined.
	app.post('/gm/join-code', c => {
		const principal = c.get('principal');
		const joinCode = generateJoinCode();
		s.rooms.setJoinCodeHash(principal.roomId, s.hashSecret('join-code', normalizeJoinCode(joinCode) as string));
		s.rooms.audit({ roomId: principal.roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'room.code-rotated' });
		return c.json({ joinCode: joinCode });
	});

	app.patch('/gm/seats/:seatId', limitBody(s.bodyLimits.small), async c => {
		const principal = c.get('principal');
		const seat = s.rooms.getSeat(c.req.param('seatId'));
		if (!seat || (seat.room_id !== principal.roomId)) {
			throw fail(404, 'Not found');
		}
		const name = requireName((await readObject(c)).name, 'name');
		const clash = s.rooms.findSeatByName(principal.roomId, name);
		if (clash && (clash.id !== seat.id)) {
			throw fail(409, 'Another seat already has that name');
		}
		s.rooms.renameSeat(seat.id, name);
		s.rooms.audit({ roomId: principal.roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'seat.renamed', detail: { seatId: seat.id, from: seat.name, to: name } });
		return c.json({ id: seat.id, name: name, isGm: seat.is_gm === 1 });
	});

	app.delete('/gm/devices/:deviceId', c => {
		const principal = c.get('principal');
		const device = s.rooms.getDevice(c.req.param('deviceId'));
		const seat = device ? s.rooms.getSeat(device.seat_id) : undefined;
		if (!device || !seat || (seat.room_id !== principal.roomId)) {
			throw fail(404, 'Not found');
		}
		if (s.rooms.revokeDevice(device.id)) {
			s.rooms.audit({ roomId: principal.roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'device.revoked', detail: { deviceId: device.id, label: device.label, seat: seat.name } });
		}
		return c.body(null, 204);
	});

	app.get('/gm/heroes/deleted', c => {
		const rows = s.heroes.listDeleted(c.get('principal').roomId);
		return c.json({ data: rows.map(row => ({ id: row.id, name: heroName(row), seatId: row.seat_id, rev: row.rev, deletedAt: row.deleted_at })) });
	});

	app.get('/gm/heroes/:heroId/revisions', c => {
		const principal = c.get('principal');
		const row = findHero(principal.roomId, c.req.param('heroId'));
		const revisions = s.heroes.listRevisions(principal.roomId, row.id).map(revision => ({
			rev: revision.rev,
			source: revision.source,
			seatId: revision.seat_id,
			deviceId: revision.device_id,
			createdAt: revision.created_at,
			current: revision.rev === row.rev
		}));
		return c.json({ data: revisions });
	});

	app.get('/gm/heroes/:heroId/revisions/:rev', c => {
		const principal = c.get('principal');
		const rev = Number(c.req.param('rev'));
		const data = Number.isInteger(rev) ? s.heroes.getRevisionData(principal.roomId, c.req.param('heroId'), rev) : undefined;
		if (!data) {
			throw fail(404, 'That revision is no longer kept');
		}
		return c.json({ data: stampHero(data, rev) });
	});

	// Restores a kept revision, or with no rev, brings back a deleted hero as it was. Either way it's a new revision.
	app.post('/gm/heroes/:heroId/restore', limitBody(s.bodyLimits.small), async c => {
		const principal = c.get('principal');
		const row = findHero(principal.roomId, c.req.param('heroId'));
		const body = (c.req.header('content-length') ?? '0') === '0' ? {} : await readObject(c);
		let data: JsonObject | undefined;
		if (body.rev === undefined) {
			if (row.deleted_at === null) {
				throw fail(400, 'Say which revision to restore');
			}
			data = JSON.parse(row.data) as JsonObject;
		} else {
			data = Number.isInteger(body.rev) ? s.heroes.getRevisionData(principal.roomId, row.id, body.rev as number) : undefined;
			if (!data) {
				throw fail(404, 'That revision is no longer kept');
			}
		}

		const result = s.heroes.save({
			roomId: principal.roomId,
			id: row.id,
			ownerSeatId: row.seat_id,
			data: data,
			stampRev: null,
			writer: { seatId: principal.seatId, deviceId: principal.deviceId, sid: null, source: 'restore' }
		});
		s.rooms.audit({ roomId: principal.roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'hero.restored', detail: { heroId: row.id, name: data.name, fromRev: body.rev ?? row.rev, rev: result.rev } });
		if (result.changed) {
			s.events.emit({ type: 'hero.changed', roomId: principal.roomId, heroId: row.id, seatId: row.seat_id, rev: result.rev, sid: null, source: 'restore' });
		}
		return c.json({ rev: result.rev, changed: result.changed });
	});

	app.get('/gm/audit', c => {
		const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 1000);
		const rows = s.rooms.listAudit(c.get('principal').roomId, limit);
		return c.json({
			data: rows.map(row => ({ id: row.id, at: row.at, seatId: row.seat_id, deviceId: row.device_id, action: row.action, detail: row.detail === null ? null : JSON.parse(row.detail) as unknown }))
		});
	});

	app.get('/gm/export', c => {
		const principal = c.get('principal');
		const payload = buildRoomExport(s, principal.roomId);
		const file = gzipSync(JSON.stringify(payload));
		s.rooms.markExported(principal.roomId);
		s.rooms.audit({ roomId: principal.roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'room.exported', detail: { heroes: payload.heroes.length, bytes: file.length } });
		const filename = `sync-steel-${fileSlug(payload.room.name)}-${payload.exportedAt.slice(0, 10)}.json.gz`;
		return c.body(new Uint8Array(file), 200, {
			'Content-Type': 'application/gzip',
			'Content-Disposition': `attachment; filename="${filename}"`
		});
	});

	// Accepts the export file as downloaded (gzipped) or plain JSON. ?dryRun=1 reports what would change.
	app.post('/gm/import', limitBody(s.bodyLimits.import), async c => {
		const principal = c.get('principal');
		const bytes = Buffer.from(await c.req.arrayBuffer());
		let text: string;
		try {
			const isGzip = (bytes[0] === 0x1f) && (bytes[1] === 0x8b);
			text = (isGzip ? gunzipSync(bytes, { maxOutputLength: MAX_IMPORT_JSON_BYTES }) : bytes).toString('utf8');
		} catch {
			throw fail(400, 'The file couldn\'t be decompressed, or it\'s too large');
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw fail(400, 'Invalid JSON');
		}

		const dryRun = [ '1', 'true' ].includes(c.req.query('dryRun') ?? '');
		const summary = importRoom(s, principal, parseRoomExport(value), dryRun);
		s.log(`  room import${dryRun ? ' (dry run)' : ''}: ${JSON.stringify(summary)}`);
		return c.json({ dryRun: dryRun, summary: summary });
	});

	app.all('/gm/*', () => {
		throw new HttpError(404, { message: 'Not found' });
	});

	return app;
};
