import type { WSContext, WSEvents } from 'hono/ws';
import type { HeroRow } from './store/heroes.ts';
import { HttpError } from './http.ts';
import type { JsonObject } from './json.ts';
import type { ServerEvent } from './events.ts';
import type { Services } from './services.ts';
import type { WebSocket } from 'ws';
import type { WebSocketLike } from '@hono/node-server';
import { stampHero } from './routes/warehouse.ts';

// The live-sync hub (report §4.5, decisions.md "Phase 3"). Forge Steel devices open GET /live, send the
// device token in their first message, and from then on are pushed each visible hero that changes.
//
// fs → server   { type: 'hello', token, heroes: { [heroId]: rev } }   the revisions the device already has
// server → fs   { type: 'welcome', serverTime, seat: { id, isGm } }
// server → fs   { type: 'hero', hero }                               a stamped hero: apply it
// server → fs   { type: 'hero.own', heroId, rev }                    this device's own save, stored as sent
// server → fs   { type: 'hero.deleted', heroId }
// fs → server   { type: 'ping' }  →  { type: 'pong' }
//
// The Owlbear extension (Phase 4) says hello with the room's Owlbear token instead. It sees every hero in the
// room, as the GM does, but never whole heroes:
// server → obr  { type: 'welcome', serverTime, kind: 'obr', room: { name } }
// server → obr  { type: 'summary', summary }                         a hero's table stats (summary.ts), with
//                                                                     rev and seatName; sent only when they change
// server → obr  { type: 'synced' }                                    after the catch-up: the list is complete
// server → obr  { type: 'hero.deleted', heroId }
//
// Close codes: 4000 no hello in time, 4001 not (or no longer) a device in the room, 4003 this server can't
// compute summaries, 4008 replaced by a newer connection, 4029 too many failed attempts, 1009 message too big.

export interface HubOptions {
	// Coalesce each hero's changes (report §4.8 stage 2)
	coalesceMs: number;
	maxWaitMs: number;
	helloTimeoutMs: number;
	// Each socket must answer a protocol ping within this long, or it's dropped
	pingMs: number;
	maxPerDevice: number;
	// Every Owlbear client in the room (the GM's laptop, the TV, remote players) shares the Owlbear token
	maxPerOwlbear: number;
	maxPerRoom: number;
	// Messages after hello are only pings
	maxMessageBytes: number;
}

export const DEFAULT_HUB_OPTIONS: HubOptions = {
	coalesceMs: 250,
	maxWaitMs: 1000,
	helloTimeoutMs: 10_000,
	pingMs: 30_000,
	maxPerDevice: 4,
	maxPerOwlbear: 20,
	maxPerRoom: 60,
	maxMessageBytes: 1024
};

// The hello carries one revision per hero, so it may be bigger than later messages
export const MAX_HELLO_BYTES = 64 * 1024;

const REVOKED_MESSAGE = 'This device has been removed from the room. Join again with the room code.';

interface Member {
	// A Forge Steel device, or the Owlbear extension, which gets summaries
	kind: 'fs' | 'obr';
	roomId: string;
	seatId: string;
	isGm: boolean;
	deviceId: string;
}

interface Connection {
	ws: WSContext<WebSocketLike>;
	ip: string;
	openedAt: number;
	member: Member | null;
	helloTimer: ReturnType<typeof setTimeout> | null;
	alive: boolean;
}

interface Pending {
	roomId: string;
	heroId: string;
	firstAt: number;
	timer: ReturnType<typeof setTimeout>;
	// The devices whose own saves, stored as sent, are in this batch; any other change makes it null
	ownBy: Set<string> | null;
}

export const createHub = (s: Services, overrides: Partial<HubOptions> = {}) => {
	const options = { ...DEFAULT_HUB_OPTIONS, ...overrides };
	const connections = new Set<Connection>();
	const pending = new Map<string, Pending>();
	// The last revision pushed for each hero: a batch that finds no newer one sends nothing
	const pushed = new Map<string, number>();
	// The last summary sent to Owlbear for each hero, without its revision: one that hasn't changed isn't sent
	const summarized = new Map<string, string>();

	const send = (connection: Connection, message: unknown) => {
		if (connection.ws.readyState === 1) {
			connection.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
		}
	};

	const close = (connection: Connection, code: number, reason: string) => {
		connection.ws.close(code, reason);
		forget(connection);
	};

	const forget = (connection: Connection) => {
		if (connection.helloTimer) {
			clearTimeout(connection.helloTimer);
		}
		connections.delete(connection);
	};

	const members = (roomId: string) => [ ...connections ].filter(connection => connection.member?.roomId === roomId);

	const canSee = (member: Member, seatId: string) => member.isGm || (member.seatId === seatId);

	const heroMessage = (data: string, rev: number) => JSON.stringify({ type: 'hero', hero: stampHero(JSON.parse(data) as JsonObject, rev) });

	// A hero's summary message, and whether it differs from the last one sent. Null if it can't be computed,
	// such as for a hero whose data upstream's HeroLogic can't read.
	const summaryMessage = (row: HeroRow) => {
		const key = `${row.room_id}/${row.id}`;
		try {
			const summary = { ...s.summarize!(JSON.parse(row.data) as JsonObject), seatName: s.rooms.getSeat(row.seat_id)?.name ?? '' };
			const signature = JSON.stringify(summary);
			const changed = summarized.get(key) !== signature;
			summarized.set(key, signature);
			return { text: JSON.stringify({ type: 'summary', summary: { ...summary, rev: row.rev } }), changed: changed };
		} catch (error) {
			s.log(`  no summary for hero ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	};

	const flush = (key: string) => {
		const batch = pending.get(key);
		pending.delete(key);
		if (!batch) {
			return;
		}
		clearTimeout(batch.timer);
		const row = s.heroes.get(batch.roomId, batch.heroId);
		if (!row || (row.deleted_at !== null) || (row.rev <= (pushed.get(key) ?? 0))) {
			return;
		}
		pushed.set(key, row.rev);

		let full: string | null = null;
		let summary: ReturnType<typeof summaryMessage> | undefined;
		members(batch.roomId).forEach(connection => {
			const member = connection.member!;
			if (!canSee(member, row.seat_id)) {
				return;
			}
			if (member.kind === 'obr') {
				if (summary === undefined) {
					summary = summaryMessage(row);
				}
				if (summary?.changed) {
					send(connection, summary.text);
				}
				return;
			}
			if (batch.ownBy && (batch.ownBy.size === 1) && batch.ownBy.has(member.deviceId)) {
				// Its screen already shows this; the revision lets it catch up correctly later
				send(connection, { type: 'hero.own', heroId: row.id, rev: row.rev });
				return;
			}
			full ??= heroMessage(row.data, row.rev);
			send(connection, full);
		});
	};

	const schedule = (event: Extract<ServerEvent, { type: 'hero.changed' }>) => {
		const key = `${event.roomId}/${event.heroId}`;
		const isOwn = (event.source === 'device') && (event.deviceId !== null) && !event.merged;
		const existing = pending.get(key);
		const nowMs = s.now();
		if (existing) {
			clearTimeout(existing.timer);
			if (existing.ownBy && isOwn) {
				existing.ownBy.add(event.deviceId!);
			} else {
				existing.ownBy = null;
			}
		}
		const batch: Pending = existing ?? { roomId: event.roomId, heroId: event.heroId, firstAt: nowMs, timer: undefined!, ownBy: isOwn ? new Set([ event.deviceId! ]) : null };
		const wait = Math.max(0, Math.min(options.coalesceMs, (batch.firstAt + options.maxWaitMs) - nowMs));
		batch.timer = setTimeout(() => flush(key), wait);
		pending.set(key, batch);
	};

	const unsubscribe = s.events.on(event => {
		switch (event.type) {
			case 'hero.changed':
				schedule(event);
				break;
			case 'hero.deleted': {
				const key = `${event.roomId}/${event.heroId}`;
				const batch = pending.get(key);
				if (batch) {
					clearTimeout(batch.timer);
					pending.delete(key);
				}
				pushed.delete(key);
				summarized.delete(key);
				members(event.roomId)
					.filter(connection => canSee(connection.member!, event.seatId))
					.forEach(connection => send(connection, { type: 'hero.deleted', heroId: event.heroId }));
				break;
			}
			case 'device.revoked':
				members(event.roomId)
					.filter(connection => connection.member!.deviceId === event.deviceId)
					.forEach(connection => close(connection, 4001, REVOKED_MESSAGE));
				break;
		}
	});

	// Sends whatever the device is missing: heroes it doesn't have or has at another revision, and the
	// deletion of any it has that it can no longer see
	const catchUp = (connection: Connection, known: Record<string, unknown>) => {
		const member = connection.member!;
		const rows = s.heroes.list(member.roomId, member.isGm ? null : member.seatId);
		const visible = new Set(rows.map(row => row.id));
		rows
			.filter(row => known[row.id] !== row.rev)
			.forEach(row => {
				if (member.kind === 'obr') {
					const summary = summaryMessage(row);
					if (summary) {
						send(connection, summary.text);
					}
				} else {
					send(connection, heroMessage(row.data, row.rev));
				}
			});
		Object.keys(known)
			.filter(id => !visible.has(id))
			.forEach(id => send(connection, { type: 'hero.deleted', heroId: id }));
		if (member.kind === 'obr') {
			// The extension's hero picker waits for the whole list
			send(connection, { type: 'synced' });
		}
	};

	const hello = (connection: Connection, message: JsonObject) => {
		const failKey = `connect-fail:${connection.ip}`;
		try {
			s.checkFailures(failKey, s.rateLimits.connectFailures);
		} catch (error) {
			if (error instanceof HttpError) {
				close(connection, 4029, 'Too many attempts. Wait a few minutes, then try again.');
				return;
			}
			throw error;
		}

		const token = typeof message.token === 'string' ? message.token : '';
		const device = token ? s.rooms.findDeviceByTokenHash(s.hashSecret('device', token)) : undefined;
		const seat = device ? s.rooms.getSeat(device.seat_id) : undefined;
		if (!device || !seat) {
			s.limiter.record(failKey, s.rateLimits.connectFailures);
			close(connection, 4001, 'Invalid token');
			return;
		}
		if (device.revoked_at) {
			close(connection, 4001, REVOKED_MESSAGE);
			return;
		}
		const kind = device.kind === 'owlbear' ? 'obr' : 'fs';
		if ((kind === 'obr') && !s.summarize) {
			close(connection, 4003, 'This server can\'t compute hero summaries for Owlbear');
			return;
		}

		// A device that reconnects before its old socket is noticed as dead replaces the oldest one
		const mine = [ ...connections ].filter(other => other.member?.deviceId === device.id);
		if (mine.length >= (kind === 'obr' ? options.maxPerOwlbear : options.maxPerDevice)) {
			mine.sort((a, b) => a.openedAt - b.openedAt);
			close(mine[0], 4008, 'Replaced by a newer connection from this device');
		}
		if (members(seat.room_id).length >= options.maxPerRoom) {
			close(connection, 4008, 'Too many connections to this room');
			return;
		}

		if (connection.helloTimer) {
			clearTimeout(connection.helloTimer);
			connection.helloTimer = null;
		}
		connection.member = { kind: kind, roomId: seat.room_id, seatId: seat.id, isGm: seat.is_gm === 1, deviceId: device.id };
		if (kind === 'obr') {
			s.rooms.touchDevice(device.id);
			s.log(`  Owlbear connected to room "${s.rooms.getRoom(seat.room_id)?.name ?? seat.room_id}"`);
			send(connection, { type: 'welcome', serverTime: s.nowIso(), kind: 'obr', room: { name: s.rooms.getRoom(seat.room_id)?.name ?? '' } });
		} else {
			send(connection, { type: 'welcome', serverTime: s.nowIso(), seat: { id: seat.id, isGm: seat.is_gm === 1 } });
		}
		catchUp(connection, (typeof message.heroes === 'object') && (message.heroes !== null) ? message.heroes as Record<string, unknown> : {});
	};

	const receive = (connection: Connection, data: unknown) => {
		const text = typeof data === 'string' ? data : '';
		const limit = connection.member ? options.maxMessageBytes : MAX_HELLO_BYTES;
		if (text.length > limit) {
			close(connection, 1009, 'Message too big');
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if ((typeof message !== 'object') || (message === null)) {
			return;
		}
		const typed = message as JsonObject;
		if (typed.type === 'ping') {
			send(connection, { type: 'pong' });
		} else if ((typed.type === 'hello') && !connection.member) {
			hello(connection, typed);
		}
	};

	// Protocol-level pings find sockets that died without closing, such as an iPad that went to sleep
	const heartbeat = setInterval(() => {
		connections.forEach(connection => {
			// @hono/node-server's sockets are ws sockets (app.ts)
			const raw = connection.ws.raw as WebSocket | undefined;
			if (!raw) {
				return;
			}
			if (!connection.alive) {
				raw.terminate();
				forget(connection);
				return;
			}
			connection.alive = false;
			raw.ping();
		});
	}, options.pingMs);
	heartbeat.unref();

	return {
		// The handlers for one upgraded request
		events: (ip: string): WSEvents<WebSocketLike> => {
			let connection: Connection | null = null;
			return {
				onOpen: (_event, ws) => {
					connection = { ws: ws, ip: ip, openedAt: s.now(), member: null, helloTimer: null, alive: true };
					const opened = connection;
					opened.helloTimer = setTimeout(() => close(opened, 4000, 'Send hello first'), options.helloTimeoutMs);
					(ws.raw as WebSocket | undefined)?.on('pong', () => {
						opened.alive = true;
					});
					connections.add(opened);
				},
				onMessage: (event, ws) => {
					if (connection && (connection.ws === ws)) {
						receive(connection, event.data);
					}
				},
				onClose: () => {
					if (connection) {
						forget(connection);
					}
				}
			};
		},
		count: () => connections.size,
		close: () => {
			unsubscribe();
			clearInterval(heartbeat);
			pending.forEach(batch => clearTimeout(batch.timer));
			pending.clear();
			pushed.clear();
			summarized.clear();
			connections.forEach(connection => connection.ws.close(1001, 'Server shutting down'));
			connections.clear();
		}
	};
};

export type Hub = ReturnType<typeof createHub>;
