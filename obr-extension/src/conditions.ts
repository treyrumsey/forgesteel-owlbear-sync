import type { SummaryCondition } from './summary.ts';

// Draw Steel's conditions as Forge Steel stores them (src/enums/condition-type.ts in the fork, which the
// extension can't import). The server checks them again (HeroSummaryLogic.applyTokenPatch).

export const CONDITION_TYPES = [ 'Bleeding', 'Dazed', 'Frightened', 'Grabbed', 'Prone', 'Restrained', 'Slowed', 'Taunted', 'Weakened', 'Custom Condition', 'Quick Condition' ] as const;

export const CONDITION_ENDS = [
	{ value: 'End of turn', label: 'End of turn' },
	{ value: 'Save ends', label: 'Save ends' },
	{ value: 'Until removed', label: 'Until removed' }
] as const;

// Custom and quick conditions are named by their text
export const needsText = (type: string) => (type === 'Custom Condition') || (type === 'Quick Condition');

export type NewCondition = { ok: true, condition: SummaryCondition } | { ok: false, problem: string };

// A condition as Forge Steel's own Add Condition menu makes it, with a fresh id
export const newCondition = (type: string, ends: string, text: string, id: string): NewCondition => {
	if (!(CONDITION_TYPES as readonly string[]).includes(type)) {
		return { ok: false, problem: 'Pick a condition.' };
	}
	if (!CONDITION_ENDS.some(end => end.value === ends)) {
		return { ok: false, problem: 'Pick when it ends.' };
	}
	const trimmed = needsText(type) ? text.trim().slice(0, 200) : '';
	if (needsText(type) && !trimmed) {
		return { ok: false, problem: 'Name the condition.' };
	}
	return { ok: true, condition: { id: id, type: type, text: trimmed, ends: ends } };
};
