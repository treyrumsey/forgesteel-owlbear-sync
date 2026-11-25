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

describe('hero merges', () => {
	const setupMerge = () => {
		const { heroes } = setup(100, 90);
		const save = (sid: string, stampRev: number | null, state: Record<string, unknown>) => heroes.save({
			roomId: 'room',
			id: 'kalla',
			ownerSeatId: 'seat',
			data: { id: 'kalla', name: 'Kalla', state: { staminaDamage: 0, notes: '', ...state } },
			stampRev: stampRev,
			writer: { seatId: 'seat', deviceId: null, sid: sid, source: 'device' }
		});
		const current = () => JSON.parse(heroes.get('room', 'kalla')!.data) as { state: Record<string, unknown> };
		return { heroes: heroes, save: save, current: current };
	};

	it('keeps a remote change when a stale debounced copy arrives', () => {
		const { save, current } = setupMerge();
		save('phone', null, {});
		// The GM's laptop takes 5 damage, then the phone saves a note from a copy that hadn't seen it
		save('laptop', 1, { staminaDamage: 5 });
		const result = save('phone', 1, { notes: 'Owes Vex 10gp' });

		expect(result).toMatchObject({ changed: true, rev: 3, baseRev: 1, merged: true, conflicts: [], warning: null });
		expect(current().state).toEqual({ staminaDamage: 5, notes: 'Owes Vex 10gp' });
	});

	it('treats a re-save of a hero another device has since changed as a no-op', () => {
		const { save, current } = setupMerge();
		save('phone', null, {});
		save('laptop', 1, { staminaDamage: 5 });
		save('laptop', 1, { staminaDamage: 6 });

		// The phone applies rev 2 from live sync, and its re-save arrives after rev 3
		const echo = save('phone', 2, { staminaDamage: 5 });

		expect(echo).toMatchObject({ changed: false, rev: 3, merged: true });
		expect(current().state.staminaDamage).toBe(6);
	});

	it('doesn\'t count an unchanged save as the session\'s write', () => {
		const { save, current } = setupMerge();
		save('phone', null, {});
		save('laptop', 1, { staminaDamage: 5 });
		// The phone applies rev 2 and re-saves it unchanged: an echo
		save('phone', 2, { staminaDamage: 5 });
		// Then the phone's hero page, which still holds rev 1, saves a note
		const stale = save('phone', 1, { notes: 'Owes Vex 10gp' });

		expect(stale).toMatchObject({ sessionRev: 1, baseRev: 1, merged: true });
		expect(current().state).toEqual({ staminaDamage: 5, notes: 'Owes Vex 10gp' });
	});

	// A drawer (such as Vitals) keeps the copy it opened with, even after the save it made was merged
	it('merges a session\'s next save against what it sent, when its last save was merged', () => {
		const { save, current } = setupMerge();
		save('phone', null, {});
		save('laptop', 1, { notes: 'Temp stamina from the GM' });
		const merged = save('phone', 1, { staminaDamage: 5 });
		expect(merged).toMatchObject({ rev: 3, merged: true });

		// The phone's drawer still has rev 1 plus its own changes, and takes more damage
		const again = save('phone', 1, { staminaDamage: 6 });

		expect(again).toMatchObject({ rev: 4, sessionRev: 3, baseRev: 3 });
		expect(current().state).toEqual({ staminaDamage: 6, notes: 'Temp stamina from the GM' });
	});

	it('merges a fresh copy of the merged revision against that revision, not against what was sent', () => {
		const { save, current } = setupMerge();
		save('phone', null, {});
		save('laptop', 1, { notes: 'From the GM' });
		save('phone', 1, { staminaDamage: 5 });

		// Live sync applies merged rev 3 on the phone, and its next save comes from that copy
		const fresh = save('phone', 3, { staminaDamage: 6, notes: 'From the GM' });

		expect(fresh).toMatchObject({ rev: 4, baseRev: 3, merged: false });
		expect(current().state).toEqual({ staminaDamage: 6, notes: 'From the GM' });
	});

	it('replaces the hero, with a warning, when the base revision is no longer kept', () => {
		const { heroes } = setup(1, 0);
		const save = (sid: string, stampRev: number | null, damage: number) => heroes.save({
			roomId: 'room',
			id: 'kalla',
			ownerSeatId: 'seat',
			data: { id: 'kalla', name: 'Kalla', state: { staminaDamage: damage } },
			stampRev: stampRev,
			writer: { seatId: 'seat', deviceId: null, sid: sid, source: 'device' }
		});
		save('a', null, 1);
		save('a', 1, 2);
		save('a', 1, 3);

		expect(save('b', 1, 9)).toMatchObject({ changed: true, merged: false, warning: 'base rev 1 is no longer kept, so this save replaced rev 3' });
	});
});
