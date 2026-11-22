import { describe, expect, it } from 'vitest';
import { createHeroStore } from './heroes.ts';
import { createRoomStore } from './rooms.ts';
import { migrate } from '../db/migrate.ts';
import { openDatabase } from '../db/database.ts';

const DAY = 24 * 60 * 60 * 1000;

const setup = (keepLast: number, dailyDays: number) => {
	const db = openDatabase(':memory:');
	migrate(db);
	const clock = { now: Date.parse('2026-11-01T10:00:00Z') };
	const rooms = createRoomStore(db, () => new Date(clock.now).toISOString());
	rooms.createRoom({ id: 'room', name: 'Room', joinCodeHash: 'code', gmKeyHash: 'key' });
	rooms.createSeat({ id: 'seat', roomId: 'room', name: 'Alice', isGm: false });
	const heroes = createHeroStore(db, () => clock.now, { keepLast: keepLast, dailyDays: dailyDays, sessionDays: 91 });
	const save = (damage: number) => heroes.save({
		roomId: 'room',
		id: 'kalla',
		ownerSeatId: 'seat',
		data: { id: 'kalla', name: 'Kalla', state: { staminaDamage: damage } },
		stampRev: null,
		writer: { seatId: 'seat', deviceId: null, sid: 's1', source: 'device' }
	});
	const kept = () => heroes.listRevisions('room', 'kalla').map(revision => revision.rev).sort((a, b) => a - b);
	return { clock: clock, heroes: heroes, save: save, kept: kept };
};

describe('hero revision retention', () => {
	it('keeps the latest revisions plus each day\'s last revision, within the daily window', () => {
		const { clock, save, kept } = setup(3, 2);

		// Day 1: revs 1-4; day 2: revs 5-6; day 3, an hour later in the day: revs 7-10
		[ 1, 2, 3, 4 ].forEach(save);
		clock.now += DAY;
		[ 5, 6 ].forEach(save);
		clock.now += DAY + (60 * 60 * 1000);
		[ 7, 8, 9, 10 ].forEach(save);

		// Rev 4 was day 1's checkpoint, but day 1 is now outside the 2-day window
		expect(kept()).toEqual([ 6, 8, 9, 10 ]);
	});

	it('stores each revision compressed, and returns the hero as it was', () => {
		const { heroes, save } = setup(10, 90);
		save(1);
		save(2);

		expect(heroes.getRevisionData('room', 'kalla', 1)).toEqual({ id: 'kalla', name: 'Kalla', state: { staminaDamage: 1 } });
		expect(heroes.getRevisionData('room', 'kalla', 9)).toBeUndefined();
	});

	it('doesn\'t add a revision for an unchanged save', () => {
		const { save, kept } = setup(10, 90);

		save(1);
		const echo = save(1);

		expect(echo).toMatchObject({ changed: false, rev: 1 });
		expect(kept()).toEqual([ 1 ]);
	});
});
