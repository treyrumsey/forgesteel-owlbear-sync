import type { WSContext, WSEvents } from 'hono/ws';
import { describeSave, stampHero } from './routes/warehouse.ts';
import { readEditId, readPatch } from './token-patch.ts';
import type { HeroRow } from './store/heroes.ts';
import { HttpError } from './http.ts';
import type { JsonObject } from './json.ts';
import type { ServerEvent } from './events.ts';
import type { Services } from './services.ts';
import type { WebSocket } from 'ws';
import type { WebSocketLike } from '@hono/node-server';

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
// A summary's rev is the revision at which the summary last changed, not the hero's latest: a change that
// doesn't show on a token (notes, say) sends nothing, so every client agrees on it. The extension stores it
// on the token as syncedRev, and (Phase 5) sends edits made on the token against it:
// obr → server  { type: 'patch', heroId, baseRev, editId, values?, conditions? }   (token-patch.ts)
// server → obr  { type: 'ack', editId, rev, summaryRev }   saved as rev; wait for a summary at summaryRev or later
// server → obr  { type: 'reject', editId, reason }         invalid, rate-limited, unknown-hero, base-gone
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
	// except the Owlbear extension's patches, which can carry conditions
	maxOwlbearMessageBytes: number;
	// A patch resent with the same edit id within this long gets the same answer, and isn't applied twice
	editMemoryMs: number;
}

export const DEFAULT_HUB_OPTIONS: HubOptions = {
	coalesceMs: 250,
	maxWaitMs: 1000,
	helloTimeoutMs: 10_000,
	pingMs: 30_000,
	maxPerDevice: 4,
	maxPerOwlbear: 20,
	maxPerRoom: 60,
	maxMessageBytes: 1024,
	maxOwlbearMessageBytes: 16 * 1024,
	editMemoryMs: 2 * 60 * 1000
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
	// Each hero's current summary, without its revision, and the revision at which it last changed
	const summaries = new Map<string, { signature: string, rev: number }>();
	// The summary revision last pushed to Owlbear for each hero: an unchanged summary isn't pushed again
	const broadcast = new Map<string, number>();
	// Recent patches' answers, by room and edit id
	const edits = new Map<string, { answer: string, at: number }>();

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

	// A hero's summary message and its summary revision. Null if it can't be computed, such as for a hero
	// whose data upstream's HeroLogic can't read. After a restart, a summary's revision starts at the hero's.
	const summaryMessage = (row: HeroRow) => {
		const key = `${row.room_id}/${row.id}`;
		try {
			const summary = { ...s.summaries!.summarize(JSON.parse(row.data) as JsonObject), seatName: s.rooms.getSeat(row.seat_id)?.name ?? '' };
			const signature = JSON.stringify(summary);
			const known = summaries.get(key);
			const rev = (known && (known.signature === signature)) ? known.rev : row.rev;
			summaries.set(key, { signature: signature, rev: rev });
			return { text: JSON.stringify({ type: 'summary', summary: { ...summary, rev: rev } }), rev: rev };
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
					if (summary && (broadcast.get(key) === summary.rev)) {
						summary = null;
					} else if (summary) {
						broadcast.set(key, summary.rev);
					}
				}
				if (summary) {
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
				summaries.delete(key);
				broadcast.delete(key);
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
		rows.forEach(row => {
			if (member.kind === 'obr') {
				const summary = summaryMessage(row);
				if (summary && (known[row.id] !== summary.rev)) {
					send(connection, summary.text);
				}
			} else if (known[row.id] !== row.rev) {
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
		if ((kind === 'obr') && !s.summaries) {
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

	// An edit made on a linked token in Owlbear (Phase 5). The token's values are applied to the hero as it was
	// at the token's summary revision, and saved against that revision as the base, so the server's three-way
	// merge (merge.ts) combines them with whatever Forge Steel changed since: counters add up, conditions merge
	// by id. The Owlbear token has no session, so the base is always the patch's.
	const patch = (connection: Connection, message: JsonObject) => {
		const member = connection.member!;
		const editId = readEditId(message);
		if (!editId) {
			return;
		}
		const editKey = `${member.roomId}/${editId}`;
		const nowMs = s.now();
		edits.forEach((edit, key) => {
			if (nowMs - edit.at > options.editMemoryMs) {
				edits.delete(key);
			}
		});
		const earlier = edits.get(editKey);
		if (earlier) {
			// Another Owlbear client forwarded the same edit, or this one resent it: it's already applied
			send(connection, earlier.answer);
			return;
		}
		const answer = (reply: JsonObject) => {
			const text = JSON.stringify({ ...reply, editId: editId });
			edits.set(editKey, { answer: text, at: nowMs });
			send(connection, text);
		};
		const reject = (reason: string) => send(connection, { type: 'reject', editId: editId, reason: reason });

		if (s.limiter.consume(`owlbear-patch:${member.deviceId}`, s.rateLimits.owlbearPatches) !== null) {
			reject('rate-limited');
			return;
		}
		const parsed = readPatch(message);
		if (!parsed) {
			reject('invalid');
			return;
		}
		const row = s.heroes.get(member.roomId, parsed.heroId);
		if (!row || (row.deleted_at !== null)) {
			reject('unknown-hero');
			return;
		}
		// The revision may have been pruned (each hero keeps its last 100), or predate the hero's re-creation
		const base = parsed.baseRev >= row.created_rev ? s.heroes.getRevisionData(member.roomId, row.id, parsed.baseRev) : undefined;
		if (!base) {
			reject('base-gone');
			return;
		}
		let incoming: JsonObject;
		try {
			incoming = s.summaries!.applyPatch(base, parsed.patch);
		} catch (error) {
			s.log(`  Owlbear edit ${editId} to hero ${row.id} rejected: ${error instanceof Error ? error.message : String(error)}`);
			reject('invalid');
			return;
		}

		const result = s.heroes.save({
			roomId: member.roomId,
			id: row.id,
			ownerSeatId: row.seat_id,
			data: incoming,
			stampRev: parsed.baseRev,
			writer: { seatId: member.seatId, deviceId: member.deviceId, sid: null, source: 'device' }
		});
		s.log(`  Owlbear edit ${editId}:${describeSave(row.id, incoming, result).slice(1)}`);
		if (result.changed) {
			s.events.emit({ type: 'hero.changed', roomId: member.roomId, heroId: row.id, seatId: row.seat_id, rev: result.rev, sid: null, deviceId: member.deviceId, merged: result.merged, source: 'device' });
		}
		const saved = s.heroes.get(member.roomId, row.id)!;
		answer({ type: 'ack', rev: result.rev, summaryRev: summaryMessage(saved)?.rev ?? result.rev });
	};

	const receive = (connection: Connection, data: unknown) => {
		const text = typeof data === 'string' ? data : '';
		const limit = !connection.member ? MAX_HELLO_BYTES : (connection.member.kind === 'obr' ? options.maxOwlbearMessageBytes : options.maxMessageBytes);
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
		} else if ((typed.type === 'patch') && (connection.member?.kind === 'obr')) {
			patch(connection, typed);
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
			summaries.clear();
			broadcast.clear();
			edits.clear();
			connections.forEach(connection => connection.ws.close(1001, 'Server shutting down'));
			connections.clear();
		}
	};
};

export type Hub = ReturnType<typeof createHub>;
