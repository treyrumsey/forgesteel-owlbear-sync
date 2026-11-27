import { CONDITION_TYPES, newCondition } from './conditions.ts';
import { EditQueue, effectiveRev, forwarderFor, planForward } from './forwarding.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DST_METADATA_KEY } from './dst-token.ts';
import type { HeroSummary } from './summary.ts';
import { LINK_KEY } from './keys.ts';
import type { PartyMember } from './election.ts';
import { syncedValues } from './token-update.ts';

const summary = (overrides: Partial<HeroSummary> = {}): HeroSummary => ({
	heroId: 'hero-1',
	rev: 4,
	seatName: 'Alice',
	name: 'Kalla',
	staminaMax: 21,
	stamina: 21,
	staminaTemp: 0,
	recoveriesMax: 10,
	recoveries: 10,
	surges: 0,
	resource: { featureId: 'fury-resource', name: 'Ferocity', value: 0 },
	conditions: [],
	...overrides
});

// A token showing the summary, with DST changes on top
const token = (dst: Record<string, unknown> = {}, syncedRev = 4) => ({
	[DST_METADATA_KEY]: {
		type: 'HERO', name: 'Kalla', staminaMaximum: 21, stamina: 21, temporaryStamina: 0, recoveries: 10, surges: 0,
		heroicResource: 0, heroicResourceName: 'Ferocity', notes: 'Table notes', ...dst
	},
	[LINK_KEY]: { heroId: 'hero-1', syncedRev: syncedRev, conditions: [] }
});

const plan = (metadata: Record<string, unknown>, extra: Partial<Parameters<typeof planForward>[0]> = {}) => planForward({
	tokenId: 'token-1',
	metadata: metadata,
	link: metadata[LINK_KEY] as never,
	lastModified: '2026-11-26T12:00:00.000Z',
	summary: summary(),
	verifyMs: 1500,
	now: 10_000,
	...extra
});

describe('forwarderFor', () => {
	const gmLaptop: PartyMember = { connectionId: 'c5', role: 'GM', name: 'GM', playerId: 'gm' };
	const gmTv: PartyMember = { connectionId: 'c2', role: 'GM', name: 'GM', playerId: 'gm' };
	const remote: PartyMember = { connectionId: 'c9', role: 'PLAYER', name: 'Remote', playerId: 'remote' };

	it('picks the editing player\'s lowest connection, so an edit is sent once', () => {
		expect(forwarderFor('gm', [ gmLaptop, gmTv, remote ], gmTv)).toBe('c2');
		expect(forwarderFor('remote', [ gmLaptop, gmTv, remote ], gmTv)).toBe('c9');
	});

	it('falls back to the elected writer when the editing player has gone', () => {
		expect(forwarderFor('left-already', [ gmLaptop, remote ], gmLaptop)).toBe('c5');
		expect(forwarderFor('left-already', [], null)).toBeNull();
	});
});

describe('planForward', () => {
	it('sends the edited fields against the summary\'s revision, with an id every client agrees on', () => {
		expect(plan(token({ stamina: 15, temporaryStamina: 3, heroicResource: 2 }))).toEqual({
			kind: 'forward',
			fields: [ 'stamina', 'temporaryStamina', 'heroicResource' ],
			patch: {
				heroId: 'hero-1',
				baseRev: 4,
				editId: 'token-1:2026-11-26T12:00:00.000Z',
				values: { stamina: 15, temporaryStamina: 3, heroicResource: 2 }
			}
		});
	});

	it('sends recoveries and surges, and negative stamina', () => {
		expect(plan(token({ recoveries: 7, surges: 2, stamina: -3 }))).toMatchObject({ kind: 'forward', patch: { values: { recoveries: 7, surges: 2, stamina: -3 } } });
	});

	it('ignores the fields that follow Forge Steel only, and DST\'s own settings', () => {
		expect(plan(token({ staminaMaximum: 30, name: 'Kal', heroicResourceName: 'Rage', notes: 'Other notes', gmOnly: true }))).toEqual({ kind: 'none', reason: 'no edited values' });
	});

	it('treats a token showing an older revision as stale: a restore, not an edit', () => {
		expect(plan(token({ stamina: 15 }, 3))).toEqual({ kind: 'stale' });
	});

	it('counts this client\'s answered patch as the token\'s revision until the writer rewrites the link', () => {
		const metadata = token({ stamina: 12 }, 4);
		const after = summary({ rev: 6, stamina: 15 });

		expect(effectiveRev({ heroId: 'hero-1', syncedRev: 4, conditions: [] }, { fromRev: 4, toRev: 6 })).toBe(6);
		expect(plan(metadata, { summary: after, patched: { fromRev: 4, toRev: 6 } })).toMatchObject({ kind: 'forward', patch: { baseRev: 6, values: { stamina: 12 } } });
		// A restored copy with an older link is still stale
		expect(plan(token({ stamina: 12 }, 2), { summary: after, patched: { fromRev: 4, toRev: 6 } })).toEqual({ kind: 'stale' });
	});

	it('skips fields Draw Steel Tools hasn\'t stored (sparse data)', () => {
		const metadata = token({ stamina: 18 });
		const dst = metadata[DST_METADATA_KEY] as Record<string, unknown>;
		delete dst.surges;
		delete dst.recoveries;

		expect(plan(metadata)).toMatchObject({ kind: 'forward', fields: [ 'stamina' ] });
	});

	it('doesn\'t send a heroic resource for a hero without one', () => {
		expect(plan(token({ heroicResource: 3 }), { summary: summary({ resource: null }) })).toEqual({ kind: 'none', reason: 'no edited values' });
	});

	it('leaves out a field DST put back to its value from before this client\'s write (spike finding 8)', () => {
		const before = syncedValues(token({ stamina: 21, surges: 2 }));
		const written = syncedValues(token({ stamina: 16, surges: 2 }));
		// Our write: stamina 21 → 16. DST then saved an older copy (stamina 21) with a surges click (2 → 3).
		const now = token({ stamina: 21, surges: 3 });
		const shown = summary({ stamina: 16, surges: 2 });

		expect(plan(now, { summary: shown, recentWrite: { before: before, written: written, at: 9_000 } }))
			.toMatchObject({ kind: 'forward', fields: [ 'surges' ], patch: { values: { surges: 3 } } });
		// Long after the write, it's an edit
		expect(plan(now, { summary: shown, recentWrite: { before: before, written: written, at: 1_000 } }))
			.toMatchObject({ kind: 'forward', fields: [ 'stamina', 'surges' ] });
	});

	it('does nothing without a summary or for a token that isn\'t a DST hero', () => {
		expect(plan(token({ stamina: 15 }), { summary: null })).toMatchObject({ kind: 'none' });
		expect(plan({ [DST_METADATA_KEY]: { type: 'MONSTER' }, [LINK_KEY]: { heroId: 'hero-1', syncedRev: 4, conditions: [] } })).toMatchObject({ kind: 'none' });
	});
});

describe('EditQueue', () => {
	let sent: { at: number, tokenId: string }[];
	let answers: boolean[];
	let start: number;

	beforeEach(() => {
		vi.useFakeTimers();
		start = Date.now();
		sent = [];
		answers = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const createQueue = () => new EditQueue({
		now: () => Date.now(),
		setTimer: (callback, ms) => setTimeout(callback, ms),
		clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
		send: async tokenId => {
			sent.push({ at: Date.now() - start, tokenId: tokenId });
			return answers.shift() ?? true;
		}
	});

	it('sends 500 ms after the last change', async () => {
		const queue = createQueue();

		queue.schedule('t1');
		await vi.advanceTimersByTimeAsync(300);
		queue.schedule('t1');
		await vi.advanceTimersByTimeAsync(499);
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		expect(sent).toEqual([ { at: 800, tokenId: 't1' } ]);
	});

	it('sends at most 2 s after the first change, however busy the token is', async () => {
		const queue = createQueue();

		for (let i = 0; i < 10; i++) {
			queue.schedule('t1');
			await vi.advanceTimersByTimeAsync(300);
		}

		expect(sent[0]).toEqual({ at: 2000, tokenId: 't1' });
	});

	it('keeps tokens apart', async () => {
		const queue = createQueue();

		queue.schedule('t1');
		await vi.advanceTimersByTimeAsync(200);
		queue.schedule('t2');
		await vi.advanceTimersByTimeAsync(600);

		expect(sent).toEqual([ { at: 500, tokenId: 't1' }, { at: 700, tokenId: 't2' } ]);
	});

	it('holds a token whose earlier patch is out until it\'s released, then sends once', async () => {
		const queue = createQueue();
		answers = [ false ];

		queue.schedule('t1');
		await vi.advanceTimersByTimeAsync(500);
		expect(queue.has('t1')).toBe(true);
		queue.schedule('t1');
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent.length).toBe(1);

		queue.release('t1');
		await vi.advanceTimersByTimeAsync(0);
		expect(sent.map(s => s.at)).toEqual([ 500, 1500 ]);
		expect(queue.has('t1')).toBe(false);
	});

	it('forgets a token, and stops', async () => {
		const queue = createQueue();

		queue.schedule('t1');
		queue.forget('t1');
		queue.schedule('t2');
		queue.stop();
		queue.schedule('t3');
		await vi.advanceTimersByTimeAsync(3000);

		expect(sent).toEqual([]);
	});
});

describe('newCondition', () => {
	it('makes a condition the way Forge Steel does', () => {
		expect(newCondition('Slowed', 'End of turn', 'ignored', 'id-1')).toEqual({ ok: true, condition: { id: 'id-1', type: 'Slowed', text: '', ends: 'End of turn' } });
		expect(newCondition('Custom Condition', 'Until removed', '  Marked  ', 'id-2')).toEqual({ ok: true, condition: { id: 'id-2', type: 'Custom Condition', text: 'Marked', ends: 'Until removed' } });
	});

	it('needs a known type and end, and a name for a custom condition', () => {
		expect(newCondition('Sleepy', 'Save ends', '', 'x')).toMatchObject({ ok: false });
		expect(newCondition('Dazed', 'EoT', '', 'x')).toMatchObject({ ok: false });
		expect(newCondition('Quick Condition', 'Save ends', ' ', 'x')).toEqual({ ok: false, problem: 'Name the condition.' });
	});

	it('lists Draw Steel\'s nine conditions plus custom and quick ones', () => {
		expect(CONDITION_TYPES).toHaveLength(11);
	});
});
