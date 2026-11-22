import { generateGmKey, generateJoinCode, normalizeJoinCode } from './secrets.ts';
import type { RoomRow } from './store/rooms.ts';
import type { Services } from './services.ts';
import { randomUUID } from 'node:crypto';
import { transaction } from './db/database.ts';

// DEV_SEED=1 gives local development a room with fixed device tokens, like the Phase 0 stub's.
// The server refuses DEV_SEED in production.

export const DEV_ROOM_NAME = 'Dev';

const DEV_DEVICES = [
	{ token: 'dev-token', seatName: 'Dev', isGm: false },
	{ token: 'dev-gm-token', seatName: 'GM', isGm: true }
];

export const seedDevRoom = (s: Services): string[] => transaction(s.db, () => {
	const lines: string[] = [];
	let room: RoomRow | undefined = s.rooms.findRoomByName(DEV_ROOM_NAME);
	if (!room) {
		const id = randomUUID();
		const joinCode = generateJoinCode();
		const gmKey = generateGmKey();
		s.rooms.createRoom({ id: id, name: DEV_ROOM_NAME, joinCodeHash: s.hashSecret('join-code', normalizeJoinCode(joinCode) as string), gmKeyHash: s.hashSecret('gm-key', gmKey) });
		s.rooms.audit({ roomId: id, action: 'room.created', detail: { name: DEV_ROOM_NAME, devSeed: true } });
		room = s.rooms.getRoom(id) as RoomRow;
		lines.push(`Created the Dev room. Join code ${joinCode}, GM key ${gmKey}`);
	}
	const roomId = room.id;

	DEV_DEVICES.forEach(device => {
		let seat = device.isGm ? s.rooms.getGmSeat(roomId) : s.rooms.findSeatByName(roomId, device.seatName);
		if (!seat) {
			const id = randomUUID();
			s.rooms.createSeat({ id: id, roomId: roomId, name: device.seatName, isGm: device.isGm });
			seat = s.rooms.getSeat(id);
		}
		const tokenHash = s.hashSecret('device', device.token);
		if (seat && !s.rooms.findDeviceByTokenHash(tokenHash)) {
			s.rooms.createDevice({ id: randomUUID(), seatId: seat.id, tokenHash: tokenHash, label: `${device.token} (dev seed)` });
		}
	});

	lines.push('Dev room device tokens: "dev-token" (seat "Dev") and "dev-gm-token" (seat "GM")');
	return lines;
});
