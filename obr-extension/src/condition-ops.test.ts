import { CONDITIONS_KEY, LINK_KEY } from './keys.ts';
import { type ConditionToken, STANDARD_TYPES, chipState, chipStates, conditionToken, planApply, readOwnConditions } from './condition-ops.ts';
import { describe, expect, it } from 'vitest';
import type { SummaryCondition } from './summary.ts';

const condition = (id: string, type: string, ends = 'Save ends', text = ''): SummaryCondition => ({ id: id, type: type, text: text, ends: ends });

const hero = (id: string, heroId: string, conditions: SummaryCondition[] = []): ConditionToken => ({ id: id, name: id, heroId: heroId, conditions: conditions });
const monster = (id: string, conditions: SummaryCondition[] = []): ConditionToken => ({ id: id, name: id, heroId: null, conditions: conditions });

const ids = () => {
	let next = 0;
	return () => `new${++next}`;
};

describe('a token\'s conditions', () => {
	it('are the hero\'s for a linked token, and its own otherwise', () => {
		const dazed = condition('c1', 'Dazed');
		const linked = { id: 't1', name: 'Wode Elf', metadata: { [LINK_KEY]: { heroId: 'h1', syncedRev: 3, conditions: [ dazed ] }, [CONDITIONS_KEY]: [ condition('x', 'Prone') ] } };
		expect(conditionToken(linked)).toEqual({ id: 't1', name: 'Wode Elf', heroId: 'h1', conditions: [ dazed ] });
		const goblin = { id: 't2', name: 'Goblin', metadata: { [CONDITIONS_KEY]: [ condition('c2', 'Prone'), 'junk', { type: 'Slowed' } ] } };
		expect(conditionToken(goblin)).toEqual({ id: 't2', name: 'Goblin', heroId: null, conditions: [ condition('c2', 'Prone') ] });
	});

	it('reads nothing from a missing or broken key', () => {
		expect(readOwnConditions(undefined)).toEqual([]);
		expect(readOwnConditions({ id: 'c1' })).toEqual([]);
	});
});

describe('chip states across a selection', () => {
	it('are all, some or none', () => {
		const tokens = [ monster('a', [ condition('1', 'Dazed'), condition('2', 'Prone') ]), monster('b', [ condition('3', 'Dazed') ]) ];
		expect(chipState(tokens, 'Dazed')).toBe('all');
		expect(chipState(tokens, 'Prone')).toBe('some');
		expect(chipState(tokens, 'Slowed')).toBe('none');
		expect(chipState([], 'Dazed')).toBe('none');
	});

	it('cover Draw Steel\'s nine conditions, not custom or quick ones', () => {
		expect(STANDARD_TYPES).toHaveLength(9);
		expect([ ...chipStates([]).keys() ]).toEqual(STANDARD_TYPES);
	});
});

describe('applying a change to a selection', () => {
	it('adds a chip\'s condition only to the tokens without it, heroes by patch and others by write', () => {
		const tokens = [ hero('t1', 'h1'), monster('g1', [ condition('c1', 'Dazed', 'End of turn') ]), monster('g2', [ condition('c2', 'Prone') ]) ];
		const plan = planApply({ kind: 'toggle', type: 'Dazed', ends: 'Save ends' }, tokens, ids());
		expect(plan).toEqual({
			ok: true,
			heroPatches: [ { heroId: 'h1', tokenIds: [ 't1' ], add: [ condition('new1', 'Dazed') ], remove: [] } ],
			ownWrites: [ { tokenId: 'g2', conditions: [ condition('c2', 'Prone'), condition('new2', 'Dazed') ] } ]
		});
	});

	it('removes every instance of a chip\'s condition when every token has it', () => {
		const tokens = [
			hero('t1', 'h1', [ condition('c1', 'Bleeding', 'End of turn'), condition('c2', 'Bleeding'), condition('c3', 'Slowed') ]),
			monster('g1', [ condition('c4', 'Bleeding') ])
		];
		const plan = planApply({ kind: 'toggle', type: 'Bleeding', ends: 'Save ends' }, tokens, ids());
		expect(plan).toEqual({
			ok: true,
			heroPatches: [ { heroId: 'h1', tokenIds: [ 't1' ], add: [], remove: [ 'c1', 'c2' ] } ],
			ownWrites: [ { tokenId: 'g1', conditions: [] } ]
		});
	});

	it('changes a hero once, however many of its tokens are selected', () => {
		const tokens = [ hero('t1', 'h1'), hero('t2', 'h1'), hero('t3', 'h2') ];
		const plan = planApply({ kind: 'toggle', type: 'Grabbed', ends: 'Until removed' }, tokens, ids());
		expect(plan.ok && plan.heroPatches.map(patch => [ patch.heroId, patch.tokenIds, patch.add.map(c => c.id) ])).toEqual([
			[ 'h1', [ 't1', 't2' ], [ 'new1' ] ],
			[ 'h2', [ 't3' ], [ 'new2' ] ]
		]);
	});

	it('adds a named custom condition to every token, and refuses one with no name', () => {
		const tokens = [ monster('g1', [ condition('c1', 'Custom Condition', 'Save ends', 'Marked') ]), monster('g2') ];
		const plan = planApply({ kind: 'add', type: 'Custom Condition', ends: 'Save ends', text: '  Marked ' }, tokens, ids());
		expect(plan.ok && plan.ownWrites.map(write => write.conditions.map(c => `${c.id}:${c.text}`))).toEqual([
			[ 'c1:Marked', 'new1:Marked' ],
			[ 'new2:Marked' ]
		]);
		expect(planApply({ kind: 'add', type: 'Quick Condition', ends: 'Save ends', text: ' ' }, tokens, ids())).toEqual({ ok: false, problem: 'Name the condition.' });
		expect(planApply({ kind: 'toggle', type: 'Sleepy', ends: 'Save ends' }, tokens, ids())).toEqual({ ok: false, problem: 'Pick a condition.' });
	});

	it('removes one condition from one token', () => {
		const tokens = [ monster('g1', [ condition('c1', 'Dazed'), condition('c2', 'Dazed', 'End of turn') ]), hero('t1', 'h1', [ condition('c3', 'Dazed') ]) ];
		expect(planApply({ kind: 'remove', tokenId: 'g1', conditionId: 'c2' }, tokens, ids())).toEqual({
			ok: true,
			heroPatches: [],
			ownWrites: [ { tokenId: 'g1', conditions: [ condition('c1', 'Dazed') ] } ]
		});
		expect(planApply({ kind: 'remove', tokenId: 't1', conditionId: 'c3' }, tokens, ids())).toEqual({
			ok: true,
			heroPatches: [ { heroId: 'h1', tokenIds: [ 't1' ], add: [], remove: [ 'c3' ] } ],
			ownWrites: []
		});
	});

	it('clears every End of turn condition and leaves untouched tokens out', () => {
		const tokens = [
			monster('g1', [ condition('c1', 'Dazed', 'End of turn'), condition('c2', 'Slowed') ]),
			monster('g2', [ condition('c3', 'Prone') ]),
			hero('t1', 'h1', [ condition('c4', 'Taunted', 'End of turn') ])
		];
		expect(planApply({ kind: 'clear-ends', ends: 'End of turn' }, tokens, ids())).toEqual({
			ok: true,
			heroPatches: [ { heroId: 'h1', tokenIds: [ 't1' ], add: [], remove: [ 'c4' ] } ],
			ownWrites: [ { tokenId: 'g1', conditions: [ condition('c2', 'Slowed') ] } ]
		});
	});
});
