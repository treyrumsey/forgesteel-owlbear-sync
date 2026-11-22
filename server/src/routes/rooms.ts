import { type AppEnv, type Services } from '../services.ts';
import { clientIp, fail, optionalString, readObject, requireName, sameHash } from '../http.ts';
import { generateDeviceToken, generateGmKey, generateJoinCode, normalizeJoinCode } from '../secrets.ts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { RoomRow } from '../store/rooms.ts';
import { limitBody } from './warehouse.ts';
import { randomUUID } from 'node:crypto';
import { transaction } from '../db/database.ts';

const NO_ROOM = 'No room has that code. Check it with your GM.';

const seatSummary = (seat: { id: string, name: string, is_gm: number }) => ({ id: seat.id, name: seat.name, isGm: seat.is_gm === 1 });

// Creating rooms and joining them: the only routes that need no device token
export const roomRoutes = (s: Services) => {
	const app = new Hono<AppEnv>();
	const small = limitBody(s.bodyLimits.small);

	// Every join attempt counts against the IP's limit; wrong codes and keys also count as failures,
	// per IP and across the server, which caps guessing even from many addresses
	const guardJoin = (c: Context) => {
		const ip = clientIp(c, s.trustProxy);
		s.limit(`join:${ip}`, s.rateLimits.join);
		s.checkFailures(`join-fail:${ip}`, s.rateLimits.joinFailures);
		s.checkFailures('join-fail:global', s.rateLimits.joinFailuresGlobal);
		return () => {
			s.limiter.record(`join-fail:${ip}`, s.rateLimits.joinFailures);
			s.limiter.record('join-fail:global', s.rateLimits.joinFailuresGlobal);
		};
	};

	const findRoomByCode = (code: unknown, recordFailure: () => void) => {
		const normalized = typeof code === 'string' ? normalizeJoinCode(code) : null;
		const room = normalized ? s.rooms.findRoomByJoinCodeHash(s.hashSecret('join-code', normalized)) : undefined;
		if (!room) {
			recordFailure();
			throw fail(404, NO_ROOM);
		}
		return room;
	};

	const gmKeyMatches = (room: RoomRow, gmKey: string | null) => (gmKey !== null) && sameHash(s.hashSecret('gm-key', gmKey), room.gm_key_hash);

	// Open to anyone, so it's rate-limited per IP and the server holds at most maxRooms rooms
	app.post('/rooms', small, async c => {
		s.limit(`rooms:${clientIp(c, s.trustProxy)}`, s.rateLimits.createRoom);
		const body = await readObject(c);
		const roomName = requireName(body.roomName, 'roomName');
		const gmSeatName = requireName(body.gmSeatName ?? 'GM', 'gmSeatName');
		const deviceLabel = requireName(body.deviceLabel, 'deviceLabel', 80);
		if (s.rooms.countRooms() >= s.maxRooms) {
			throw fail(403, 'This server already has as many rooms as it allows');
		}

		const joinCode = generateJoinCode();
		const gmKey = generateGmKey();
		const deviceToken = generateDeviceToken();
		const room = { id: randomUUID(), name: roomName };
		const seat = { id: randomUUID(), roomId: room.id, name: gmSeatName, isGm: true };
		const deviceId = randomUUID();
		transaction(s.db, () => {
			s.rooms.createRoom({ ...room, joinCodeHash: s.hashSecret('join-code', normalizeJoinCode(joinCode) as string), gmKeyHash: s.hashSecret('gm-key', gmKey) });
			s.rooms.createSeat(seat);
			s.rooms.createDevice({ id: deviceId, seatId: seat.id, tokenHash: s.hashSecret('device', deviceToken), label: deviceLabel });
			s.rooms.audit({ roomId: room.id, seatId: seat.id, deviceId: deviceId, action: 'room.created', detail: { name: roomName, deviceLabel: deviceLabel } });
		});
		s.log(`  room "${roomName}" created`);

		return c.json({ room: room, seat: { id: seat.id, name: seat.name, isGm: true }, joinCode: joinCode, gmKey: gmKey, deviceToken: deviceToken }, 201);
	});

	app.post('/join/lookup', small, async c => {
		const recordFailure = guardJoin(c);
		const body = await readObject(c);
		const room = findRoomByCode(body.code, recordFailure);
		return c.json({ room: { name: room.name }, seats: s.rooms.listSeats(room.id).map(seatSummary) });
	});

	// Anyone with the code can pick or create a player seat; the GM seat also needs the GM key.
	// With only the GM key, the GM can sign a new device into the GM seat without the code.
	app.post('/join', small, async c => {
		const recordFailure = guardJoin(c);
		const body = await readObject(c);
		const deviceLabel = requireName(body.deviceLabel, 'deviceLabel', 80);
		const gmKey = optionalString(body.gmKey);

		let room: RoomRow | undefined;
		if (body.code !== undefined) {
			room = findRoomByCode(body.code, recordFailure);
		} else if (gmKey !== null) {
			room = s.rooms.findRoomByGmKeyHash(s.hashSecret('gm-key', gmKey));
			if (!room) {
				recordFailure();
				throw fail(403, 'That GM key doesn\'t match any room');
			}
		} else {
			throw fail(400, 'Enter the room code');
		}
		const roomId = room.id;

		const seatId = optionalString(body.seatId);
		const newSeatName = body.newSeatName === undefined ? null : requireName(body.newSeatName, 'newSeatName');
		let seat = seatId ? s.rooms.getSeat(seatId) : undefined;
		if (seatId && (!seat || (seat.room_id !== roomId))) {
			throw fail(404, 'That seat isn\'t in this room');
		}
		if (!seat && (newSeatName === null)) {
			if (body.code !== undefined) {
				throw fail(400, 'Pick a seat, or enter a name for a new one');
			}
			seat = s.rooms.getGmSeat(roomId);
		}
		if (seat && (seat.is_gm === 1) && !gmKeyMatches(room, gmKey)) {
			recordFailure();
			throw fail(403, 'The GM seat needs the GM key');
		}
		if (!seat && (newSeatName !== null) && s.rooms.findSeatByName(roomId, newSeatName)) {
			throw fail(409, 'A seat with that name already exists. Pick it instead.');
		}

		const deviceToken = generateDeviceToken();
		const deviceId = randomUUID();
		const joined = transaction(s.db, () => {
			let target = seat;
			if (!target) {
				const id = randomUUID();
				s.rooms.createSeat({ id: id, roomId: roomId, name: newSeatName as string, isGm: false });
				target = s.rooms.getSeat(id);
			}
			if (!target) {
				throw new Error('Seat was not created');
			}
			s.rooms.createDevice({ id: deviceId, seatId: target.id, tokenHash: s.hashSecret('device', deviceToken), label: deviceLabel });
			s.rooms.audit({ roomId: roomId, seatId: target.id, deviceId: deviceId, action: 'device.joined', detail: { label: deviceLabel, newSeat: !seat } });
			return target;
		});
		s.log(`  device "${deviceLabel}" joined seat "${joined.name}"`);

		return c.json({ room: { id: roomId, name: room.name }, seat: seatSummary(joined), deviceToken: deviceToken }, 201);
	});

	return app;
};
