import { CONDITION_TYPES, needsText, newCondition } from './conditions.ts';
import { CONDITIONS_KEY } from './keys.ts';
import type { SummaryCondition } from './summary.ts';
import { readLink } from './links.ts';

// Conditions on any token, linked or not, and what a change to a selection of tokens means (decisions.md
// "Conditions UI: in-menu chips and an overview"):
// - a linked token's conditions are its hero's (LINK_KEY), changed by a patch to the hero;
// - any other token's are its own (CONDITIONS_KEY), changed by writing the token.
// No SDK here, so it can be tested.

// The conditions with a chip of their own: Draw Steel's nine, not custom or quick ones
export const STANDARD_TYPES: readonly string[] = CONDITION_TYPES.filter(type => !needsText(type));

export interface ConditionToken {
	id: string;
	name: string;
	// The hero it's linked to, or null for a token with its own conditions
	heroId: string | null;
	conditions: SummaryCondition[];
}

// A token's own conditions, as written under CONDITIONS_KEY
export const readOwnConditions = (value: unknown): SummaryCondition[] => {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((c): c is Record<string, unknown> => (typeof c === 'object') && (c !== null) && (typeof (c as Record<string, unknown>).id === 'string'))
		.map(c => ({
			id: c.id as string,
			type: typeof c.type === 'string' ? c.type : '',
			text: typeof c.text === 'string' ? c.text : '',
			ends: typeof c.ends === 'string' ? c.ends : ''
		}));
};

export const conditionToken = (item: { id: string, name: string, metadata: Record<string, unknown> }): ConditionToken => {
	const link = readLink(item.metadata);
	return {
		id: item.id,
		name: item.name,
		heroId: link?.heroId ?? null,
		conditions: link ? link.conditions : readOwnConditions(item.metadata[CONDITIONS_KEY])
	};
};

export type ChipState = 'all' | 'some' | 'none';

const hasType = (conditions: SummaryCondition[], type: string) => conditions.some(c => c.type === type);

// Whether every, some or none of the tokens has the condition
export const chipState = (tokens: ConditionToken[], type: string): ChipState => {
	const count = tokens.filter(token => hasType(token.conditions, type)).length;
	if ((count === 0) || (tokens.length === 0)) {
		return 'none';
	}
	return count === tokens.length ? 'all' : 'some';
};

export const chipStates = (tokens: ConditionToken[]) => new Map(STANDARD_TYPES.map(type => [ type, chipState(tokens, type) ]));

export type ConditionOp =
	// A chip: if every token has it, remove it from all of them; otherwise add it to those without it
	| { kind: 'toggle', type: string, ends: string }
	// Any condition, custom and quick ones included, to every token
	| { kind: 'add', type: string, ends: string, text: string }
	// One condition from one token
	| { kind: 'remove', tokenId: string, conditionId: string }
	// Every condition that ends this way, from every token (such as clearing End of turn)
	| { kind: 'clear-ends', ends: string };

export interface HeroPatch {
	heroId: string;
	tokenIds: string[];
	add: SummaryCondition[];
	remove: string[];
}

export interface OwnWrite {
	tokenId: string;
	conditions: SummaryCondition[];
}

export type ApplyPlan = { ok: true, heroPatches: HeroPatch[], ownWrites: OwnWrite[] } | { ok: false, problem: string };

// The tokens to change, grouped: one group per hero (however many of its tokens are there), one per other token
interface Group {
	heroId: string | null;
	tokenIds: string[];
	conditions: SummaryCondition[];
}

const groupTokens = (tokens: ConditionToken[]) => {
	const groups: Group[] = [];
	const byHero = new Map<string, Group>();
	tokens.forEach(token => {
		if (token.heroId === null) {
			groups.push({ heroId: null, tokenIds: [ token.id ], conditions: token.conditions });
			return;
		}
		const known = byHero.get(token.heroId);
		if (known) {
			known.tokenIds.push(token.id);
			return;
		}
		const group = { heroId: token.heroId, tokenIds: [ token.id ], conditions: token.conditions };
		byHero.set(token.heroId, group);
		groups.push(group);
	});
	return groups;
};

// What to send and write so the change applies to every token. Each new condition gets its own id.
export const planApply = (op: ConditionOp, tokens: ConditionToken[], newId: () => string): ApplyPlan => {
	const groups = groupTokens(tokens);
	const changes: { group: Group, add: SummaryCondition[], remove: string[] }[] = [];

	if (op.kind === 'toggle' || op.kind === 'add') {
		const check = newCondition(op.type, op.ends, op.kind === 'add' ? op.text : '', 'check');
		if (!check.ok) {
			return { ok: false, problem: check.problem };
		}
	}

	const removeAll = (op.kind === 'toggle') && (chipState(tokens, op.type) === 'all');
	groups.forEach(group => {
		let add: SummaryCondition[] = [];
		let remove: string[] = [];
		switch (op.kind) {
			case 'toggle':
				if (removeAll) {
					remove = group.conditions.filter(c => c.type === op.type).map(c => c.id);
				} else if (!hasType(group.conditions, op.type)) {
					const made = newCondition(op.type, op.ends, '', newId());
					add = made.ok ? [ made.condition ] : [];
				}
				break;
			case 'add': {
				const made = newCondition(op.type, op.ends, op.text, newId());
				add = made.ok ? [ made.condition ] : [];
				break;
			}
			case 'remove':
				if (group.tokenIds.includes(op.tokenId) && group.conditions.some(c => c.id === op.conditionId)) {
					remove = [ op.conditionId ];
				}
				break;
			case 'clear-ends':
				remove = group.conditions.filter(c => c.ends === op.ends).map(c => c.id);
				break;
		}
		if ((add.length > 0) || (remove.length > 0)) {
			changes.push({ group: group, add: add, remove: remove });
		}
	});

	return {
		ok: true,
		heroPatches: changes
			.filter(change => change.group.heroId !== null)
			.map(change => ({ heroId: change.group.heroId!, tokenIds: change.group.tokenIds, add: change.add, remove: change.remove })),
		ownWrites: changes
			.filter(change => change.group.heroId === null)
			.map(change => ({
				tokenId: change.group.tokenIds[0],
				conditions: [ ...change.group.conditions.filter(c => !change.remove.includes(c.id)), ...change.add ]
			}))
	};
};
