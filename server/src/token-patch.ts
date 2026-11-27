import { type JsonObject, isObject } from './json.ts';
import type { HeroTokenPatch } from './summary.ts';

// The Owlbear extension's `patch` message (Phase 5, report §4.5): an edit made on a linked token, against the
// summary revision the token was synced at.
//
// obr → server  { type: 'patch', heroId, baseRev, editId, values?, conditions?: { add?, remove? } }
//
// This checks the message's shape. Whether the values and conditions make sense for the hero is
// HeroSummaryLogic.applyTokenPatch's job, which throws if not.

export interface PatchMessage {
	heroId: string;
	baseRev: number;
	editId: string;
	patch: HeroTokenPatch;
}

const VALUE_FIELDS = [ 'stamina', 'temporaryStamina', 'recoveries', 'surges', 'heroicResource' ] as const;
const MAX_VALUE = 100_000;
const MAX_CONDITIONS = 50;

const isId = (value: unknown, max = 200): value is string => (typeof value === 'string') && (value.length > 0) && (value.length <= max);

// The edit id alone, so even a malformed patch can be answered
export const readEditId = (message: JsonObject) => isId(message.editId) ? message.editId : null;

export const readPatch = (message: JsonObject): PatchMessage | null => {
	const editId = readEditId(message);
	const { heroId, baseRev, values, conditions } = message;
	if (!editId || !isId(heroId) || !Number.isInteger(baseRev) || ((baseRev as number) < 1)) {
		return null;
	}

	const patch: HeroTokenPatch = {};
	if (values !== undefined) {
		if (!isObject(values)) {
			return null;
		}
		const read: NonNullable<HeroTokenPatch['values']> = {};
		for (const field of VALUE_FIELDS) {
			const value = values[field];
			if (value === undefined) {
				continue;
			}
			if ((typeof value !== 'number') || !Number.isFinite(value) || (Math.abs(value) > MAX_VALUE)) {
				return null;
			}
			read[field] = value;
		}
		if (Object.keys(read).length > 0) {
			patch.values = read;
		}
	}

	if (conditions !== undefined) {
		if (!isObject(conditions)) {
			return null;
		}
		const add = conditions.add ?? [];
		const remove = conditions.remove ?? [];
		if (!Array.isArray(add) || !Array.isArray(remove) || (add.length > MAX_CONDITIONS) || (remove.length > MAX_CONDITIONS)) {
			return null;
		}
		if (!add.every(isObject) || !remove.every(id => isId(id, 100))) {
			return null;
		}
		if ((add.length > 0) || (remove.length > 0)) {
			patch.conditions = { add: add as never, remove: remove as string[] };
		}
	}

	if (!patch.values && !patch.conditions) {
		return null;
	}
	return { heroId: heroId as string, baseRev: baseRev as number, editId: editId, patch: patch };
};
