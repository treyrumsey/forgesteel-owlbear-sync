import { type AppEnv, type Principal, type Services } from '../services.ts';
import { DATA_KEYS, requireDevice } from './auth.ts';
import { type JsonObject, isObject } from '../json.ts';
import { fail, readJson } from '../http.ts';
import { Hono } from 'hono';
import type { SaveHeroResult } from '../store/heroes.ts';
import type { SeatDataKey } from '../store/seat-data.ts';
import { bodyLimit } from 'hono/body-limit';

// The Forge Steel Warehouse API (report §4.3). Response shapes follow the reference Warehouse
// (Veritas1000/forgesteel-warehouse@25f24db), so Forge Steel's unmodified WarehouseService can use it.

export const limitBody = (maxSize: number) => bodyLimit({
	maxSize: maxSize,
	onError: c => c.json({ message: 'Payload too large' }, 413)
});

// The server's revision travels inside the hero, so a later save says which revision it was based on
export const stampHero = (data: JsonObject, rev: number) => ({ ...data, _syncSteel: { rev: rev } });

export const describeSave = (id: string, data: JsonObject, result: SaveHeroResult) => {
	const label = `hero ${id} "${typeof data.name === 'string' ? data.name : ''}"`;
	const bases = `stamp rev ${result.stampRev ?? 'none'}, session wrote rev ${result.sessionRev ?? 'none'}, base rev ${result.baseRev ?? 'none'}`;
	const notes = [ result.merged ? 'merged' : null, result.conflicts.length > 0 ? `this save won ${result.conflicts.join(', ')}` : null ].filter(note => note !== null);
	const merge = notes.length > 0 ? `; ${notes.join('; ')}` : '';
	if (!result.changed) {
		return `  ${label} unchanged at rev ${result.rev} (${bases}${merge})`;
	}
	return `  ${label} rev ${result.previousRev} -> ${result.rev} (${bases}${merge})${result.warning ? ` WARNING: ${result.warning}` : ''}`;
};

export const warehouseRoutes = (s: Services) => {
	const app = new Hono<AppEnv>();
	const device = requireDevice(s);

	// Players see their own seat's heroes; the GM sees every hero in the room
	const findVisibleHero = (principal: Principal, id: string) => {
		const row = s.heroes.get(principal.roomId, id);
		if (!row || (row.deleted_at !== null) || (!principal.isGm && (row.seat_id !== principal.seatId))) {
			return undefined;
		}
		return row;
	};

	app.get('/data/forgesteel-heroes', device, c => {
		const principal = c.get('principal');
		const fields = c.req.query('fields');
		const rows = s.heroes.list(principal.roomId, principal.isGm ? null : principal.seatId);
		const list = rows.map(row => {
			const data = JSON.parse(row.data) as JsonObject;
			if (fields === undefined) {
				return stampHero(data, row.rev);
			}
			const partial: JsonObject = { id: data.id };
			fields.split(',')
				.filter(field => field in data)
				.forEach(field => partial[field] = data[field]);
			return partial;
		});
		return c.json({ data: list });
	});

	app.get('/data/forgesteel-heroes/:id', device, c => {
		const row = findVisibleHero(c.get('principal'), c.req.param('id'));
		if (!row) {
			throw fail(404, 'Not found');
		}
		return c.json({ data: stampHero(JSON.parse(row.data) as JsonObject, row.rev) });
	});

	app.put('/data/forgesteel-heroes/:id', device, limitBody(s.bodyLimits.hero), async c => {
		const principal = c.get('principal');
		const id = c.req.param('id');
		const body = await readJson(c);
		if (!isObject(body) || (body.id !== id)) {
			return c.text('Hero id must be present and match the url', 400);
		}

		const { _syncSteel: stamp, ...data } = body;
		const stampRev = isObject(stamp) && Number.isInteger(stamp.rev) ? stamp.rev as number : null;
		const existing = s.heroes.get(principal.roomId, id);
		if (existing && !principal.isGm && (existing.seat_id !== principal.seatId)) {
			throw fail(403, 'This hero belongs to another seat in the room');
		}

		const ownerSeatId = existing ? existing.seat_id : principal.seatId;
		const result = s.heroes.save({
			roomId: principal.roomId,
			id: id,
			ownerSeatId: ownerSeatId,
			data: data,
			stampRev: stampRev,
			writer: { seatId: principal.seatId, deviceId: principal.deviceId, sid: principal.sid, source: 'device' }
		});
		s.log(describeSave(id, data, result));
		if (result.changed) {
			s.events.emit({ type: 'hero.changed', roomId: principal.roomId, heroId: id, seatId: ownerSeatId, rev: result.rev, sid: principal.sid, deviceId: principal.deviceId, merged: result.merged, source: 'device' });
		}
		return c.body(null, 204);
	});

	app.delete('/data/forgesteel-heroes/:id', device, c => {
		const principal = c.get('principal');
		const id = c.req.param('id');
		const row = findVisibleHero(principal, id);
		if (!row) {
			// Already deleted, for example on another device: Sync Steel's live sync then removes it here
			// through Forge Steel's own deleteHero, which only updates the screen once the DELETE succeeds
			const gone = s.heroes.get(principal.roomId, id);
			if (gone && (gone.deleted_at !== null) && (principal.isGm || (gone.seat_id === principal.seatId))) {
				return c.body(null, 204);
			}
			throw fail(404, 'Not found');
		}
		if (!s.heroes.softDelete(principal.roomId, row.id)) {
			throw fail(404, 'Not found');
		}
		const name = (JSON.parse(row.data) as JsonObject).name;
		s.rooms.audit({ roomId: principal.roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'hero.deleted', detail: { heroId: row.id, name: name } });
		s.events.emit({ type: 'hero.deleted', roomId: principal.roomId, heroId: row.id, seatId: row.seat_id, rev: row.rev });
		return c.body(null, 204);
	});

	// Homebrew is shared by the whole room, because heroes depend on it
	app.get('/data/forgesteel-homebrew-settings', device, c => {
		const rows = s.homebrew.list(c.get('principal').roomId);
		return c.json({ data: rows.map(row => JSON.parse(row.data) as unknown) });
	});

	app.get('/data/forgesteel-homebrew-settings/:id', device, c => {
		const row = s.homebrew.get(c.get('principal').roomId, c.req.param('id'));
		if (!row || (row.deleted_at !== null)) {
			throw fail(404, 'Not found');
		}
		return c.json({ data: JSON.parse(row.data) as unknown });
	});

	app.put('/data/forgesteel-homebrew-settings/:id', device, limitBody(s.bodyLimits.homebrew), async c => {
		const principal = c.get('principal');
		const id = c.req.param('id');
		const body = await readJson(c);
		if (!isObject(body) || (body.id !== id)) {
			return c.text('Homebrew id must be present and match the url', 400);
		}
		s.homebrew.save(principal.roomId, id, body, principal.seatId);
		return c.body(null, 204);
	});

	app.delete('/data/forgesteel-homebrew-settings/:id', device, c => {
		const principal = c.get('principal');
		const row = s.homebrew.get(principal.roomId, c.req.param('id'));
		if (!row || !s.homebrew.softDelete(principal.roomId, row.id)) {
			throw fail(404, 'Not found');
		}
		const name = (JSON.parse(row.data) as JsonObject).name;
		s.rooms.audit({ roomId: principal.roomId, seatId: principal.seatId, deviceId: principal.deviceId, action: 'homebrew.deleted', detail: { id: row.id, name: name } });
		return c.body(null, 204);
	});

	// Session data and hidden sourcebook ids belong to each seat
	const seatValue = (path: string, key: SeatDataKey) => {
		app.get(path, device, c => c.json({ data: s.seatData.get(c.get('principal').seatId, key) }));
		app.put(path, device, limitBody(s.bodyLimits.seatData), async c => {
			s.seatData.put(c.get('principal').seatId, key, await readJson(c));
			return c.body(null, 204);
		});
	};
	seatValue('/data/forgesteel-session', 'session');
	seatValue('/data/forgesteel-hidden-setting-ids', 'hidden-setting-ids');

	const unmatched = (key: string) => {
		if (DATA_KEYS.includes(key)) {
			throw fail(405, 'Method not allowed');
		}
		throw fail(404, `Unknown data key: ${key}`);
	};
	app.all('/data/:key', device, c => unmatched(c.req.param('key')));
	app.all('/data/:key/:id', device, c => unmatched(c.req.param('key')));

	return app;
};
