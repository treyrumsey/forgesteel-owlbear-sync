import { type StackLabel, conditionLabel, inStack, labelId, planLabels, readTag, slotAt, slotPosition } from './labels.ts';
import { describe, expect, it } from 'vitest';
import type { SummaryCondition } from './summary.ts';

const anchor = { x: 100, y: 200 };

const condition = (id: string, type: string, ends = 'Save ends', text = ''): SummaryCondition => ({ id: id, type: type, text: text, ends: ends });

// A label token-labels made by hand, at one of its slots
const theirs = (id: string, slot: number, text = 'Winded'): StackLabel => ({ id: `t1-label-${id}`, text: text, position: slotPosition(anchor, slot), tag: null });

// One of ours, as planLabels would have placed it
const ours = (c: SummaryCondition, slot: number): StackLabel => ({
	id: labelId('t1', c.id),
	text: conditionLabel(c),
	position: slotPosition(anchor, slot),
	tag: { tokenId: 't1', conditionId: c.id }
});

const bleeding = condition('c1', 'Bleeding', 'End of turn');
const dazed = condition('c2', 'Dazed');
const slowed = condition('c3', 'Slowed', 'Until removed');

describe('the token-labels stack', () => {
	it('puts the first label 15 below the token\'s top-left, the second below it, and the rest above', () => {
		expect([ 0, 1, 2, 3 ].map(slot => slotPosition(anchor, slot).y - anchor.y)).toEqual([ 15, 50, -20, -55 ]);
		expect(slotPosition(anchor, 0).x).toBe(100);
	});

	it('reads back the slot a label is in, and none for one moved off the stack', () => {
		expect([ 0, 1, 2, 3, 6 ].map(slot => slotAt(anchor, slotPosition(anchor, slot)))).toEqual([ 0, 1, 2, 3, 6 ]);
		expect(slotAt(anchor, { x: 100, y: 200 + 15 + (35 * 4) })).toBeNull();
	});

	it('names ours so token-labels counts them, and reads our tag', () => {
		expect(labelId('t1', 'c1')).toBe('t1-label-sync-steel-c1');
		expect(inStack('t1', labelId('t1', 'c1'))).toBe(true);
		expect(inStack('t1', 't1-label-1712345678')).toBe(true);
		expect(inStack('t1', 't2-label-sync-steel-c1')).toBe(false);
		expect(readTag({ tokenId: 't1', conditionId: 'c1', extra: 1 })).toEqual({ tokenId: 't1', conditionId: 'c1' });
		expect(readTag({ tokenId: 't1' })).toBeNull();
	});

	it('words conditions as token-labels\' Draw Steel list does', () => {
		expect(conditionLabel(bleeding)).toBe('Bleeding (EoT)');
		expect(conditionLabel(dazed)).toBe('Dazed (SE)');
		expect(conditionLabel(slowed)).toBe('Slowed');
		expect(conditionLabel(condition('c4', 'Custom Condition', 'Until removed', ' Hexed '))).toBe('Hexed');
		expect(conditionLabel(condition('c5', 'Quick Condition', 'End of turn', 'A very long condition name indeed'))).toHaveLength(24);
	});
});

describe('planLabels', () => {
	it('adds a label for each condition, in order, in the first slots', () => {
		const plan = planLabels('t1', anchor, [ bleeding, dazed ], []);

		expect(plan.delete).toEqual([]);
		expect(plan.update).toEqual([]);
		expect(plan.add).toEqual([
			{ id: 't1-label-sync-steel-c1', tokenId: 't1', conditionId: 'c1', text: 'Bleeding (EoT)', position: slotPosition(anchor, 0) },
			{ id: 't1-label-sync-steel-c2', tokenId: 't1', conditionId: 'c2', text: 'Dazed (SE)', position: slotPosition(anchor, 1) }
		]);
	});

	it('stacks ours after token-labels\' own, which stay where they are', () => {
		const plan = planLabels('t1', anchor, [ bleeding, dazed ], [ theirs('a', 0), theirs('b', 1, 'Dying') ]);

		expect(plan.add.map(label => label.position)).toEqual([ slotPosition(anchor, 2), slotPosition(anchor, 3) ]);
		expect(plan.update).toEqual([]);
		expect(plan.delete).toEqual([]);
	});

	it('fills a gap token-labels left', () => {
		const plan = planLabels('t1', anchor, [ bleeding ], [ theirs('a', 0), theirs('b', 2) ]);

		expect(plan.add[0].position).toEqual(slotPosition(anchor, 1));
	});

	it('changes nothing when the labels already show the conditions', () => {
		expect(planLabels('t1', anchor, [ bleeding, dazed ], [ ours(bleeding, 0), ours(dazed, 1), theirs('a', 2) ]))
			.toEqual({ add: [], update: [], delete: [] });
	});

	it('leaves ours where a token-labels tidy-up put them while our set is the same', () => {
		const moved = { ...ours(bleeding, 0), position: { x: 400, y: 900 } };

		expect(planLabels('t1', anchor, [ bleeding ], [ moved, theirs('a', 1) ])).toEqual({ add: [], update: [], delete: [] });
	});

	it('removes a condition\'s label and packs ours up behind token-labels\' own', () => {
		const plan = planLabels('t1', anchor, [ dazed, slowed ], [ theirs('a', 0), ours(bleeding, 1), ours(dazed, 2), ours(slowed, 3) ]);

		expect(plan.delete).toEqual([ 't1-label-sync-steel-c1' ]);
		expect(plan.add).toEqual([]);
		expect(plan.update).toEqual([
			{ id: 't1-label-sync-steel-c2', position: slotPosition(anchor, 1) },
			{ id: 't1-label-sync-steel-c3', position: slotPosition(anchor, 2) }
		]);
	});

	it('puts back a label someone deleted', () => {
		const plan = planLabels('t1', anchor, [ bleeding, dazed ], [ ours(bleeding, 0) ]);

		expect(plan.add.map(label => [ label.id, label.position ])).toEqual([ [ 't1-label-sync-steel-c2', slotPosition(anchor, 1) ] ]);
		expect(plan.update).toEqual([]);
	});

	it('updates the text when a condition changes how it ends, without moving it', () => {
		const plan = planLabels('t1', anchor, [ { ...bleeding, ends: 'Save ends' } ], [ ours(bleeding, 0) ]);

		expect(plan).toEqual({ add: [], update: [ { id: 't1-label-sync-steel-c1', text: 'Bleeding (SE)' } ], delete: [] });
	});

	it('removes every label of ours when the hero has no conditions, and only ours', () => {
		const plan = planLabels('t1', anchor, [], [ theirs('a', 0), ours(bleeding, 1) ]);

		expect(plan).toEqual({ add: [], update: [], delete: [ 't1-label-sync-steel-c1' ] });
	});

	it('ignores other tokens\' labels and anything else attached', () => {
		const other: StackLabel = { id: 't2-label-sync-steel-c9', text: 'Prone', position: slotPosition(anchor, 0), tag: { tokenId: 't2', conditionId: 'c9' } };
		const unrelated: StackLabel = { id: 'aura-1', text: '', position: slotPosition(anchor, 0), tag: null };

		expect(planLabels('t1', anchor, [ bleeding ], [ other, unrelated ]).add[0].position).toEqual(slotPosition(anchor, 0));
	});

	it('makes one label for a condition listed twice', () => {
		expect(planLabels('t1', anchor, [ bleeding, bleeding ], []).add).toHaveLength(1);
	});
});
