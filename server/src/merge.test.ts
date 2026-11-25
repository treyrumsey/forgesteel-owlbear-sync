import { describe, expect, it } from 'vitest';
import type { JsonObject } from './json.ts';
import { mergeHero } from './merge.ts';

const condition = (id: string, text = '') => ({ id: id, type: 'Bleeding', text: text, ends: 'EoT' });

const resource = (value: number) => ({ id: 'fury-resource', type: 'Heroic Resource', name: 'Ferocity', data: { type: 'heroic', value: value } });

const hero = (changes: { state?: JsonObject, class?: JsonObject } & JsonObject = {}): JsonObject => {
	const { state, class: heroClass, ...rest } = changes;
	return {
		id: 'h',
		name: 'Kalla',
		folder: '',
		ancestry: { id: 'human' },
		class: { id: 'fury', level: 1, featuresByLevel: [ { level: 1, features: [ resource(0) ] } ], ...heroClass },
		state: { staminaDamage: 0, surges: 0, notes: '', inventory: [], conditions: [], ...state },
		...rest
	};
};

const getResource = (merged: JsonObject) => {
	const heroClass = merged.class as { featuresByLevel: { features: { data: { value: number } }[] }[] };
	return heroClass.featuresByLevel[0].features[0].data.value;
};

describe('mergeHero', () => {
	it('keeps a change only the server has', () => {
		const result = mergeHero(hero(), hero({ name: 'Kalla the Bold' }), hero({ state: { staminaDamage: 4 } }));

		expect(result.merged.name).toBe('Kalla the Bold');
		expect((result.merged.state as JsonObject).staminaDamage).toBe(4);
		expect(result.conflicts).toEqual([]);
	});

	it('merges state fields one by one', () => {
		const result = mergeHero(hero(), hero({ state: { staminaDamage: 7 } }), hero({ state: { notes: 'Owes Vex 10gp' } }));

		expect(result.merged.state).toMatchObject({ staminaDamage: 7, notes: 'Owes Vex 10gp' });
		expect(result.conflicts).toEqual([]);
	});

	it('lets the saving device win a field both changed, and reports it', () => {
		const result = mergeHero(hero(), hero({ state: { notes: 'GM note' } }), hero({ state: { notes: 'Player note' } }));

		expect((result.merged.state as JsonObject).notes).toBe('Player note');
		expect(result.conflicts).toEqual([ 'state.notes' ]);
	});

	it('combines a counter both sides changed', () => {
		// The GM adds 4 temporary stamina while the player, from a copy without it, takes 1 damage from theirs
		const base = hero({ state: { staminaTemp: 3, staminaDamage: 7 } });
		const current = hero({ state: { staminaTemp: 7, staminaDamage: 7 } });
		const incoming = hero({ state: { staminaTemp: 2, staminaDamage: 7 } });

		const result = mergeHero(base, current, incoming);

		expect(result.merged.state).toMatchObject({ staminaTemp: 6, staminaDamage: 7 });
		expect(result.conflicts).toEqual([]);
	});

	it('takes the saving device\'s counter when only it changed', () => {
		const result = mergeHero(hero(), hero({ state: { surges: 0 } }), hero({ state: { surges: 2 } }));

		expect((result.merged.state as JsonObject).surges).toBe(2);
	});

	it('treats other top-level parts as a whole', () => {
		const base = hero();
		const current = hero({ ancestry: { id: 'human', signature: 'a' } });
		const incoming = hero({ ancestry: { id: 'dwarf' } });

		expect(mergeHero(base, current, incoming).merged.ancestry).toEqual({ id: 'dwarf' });
	});

	it('keeps keys the server added and drops keys the saving device removed', () => {
		const result = mergeHero(hero({ picture: 'x' }), hero({ picture: 'x', extensionIDs: [ 'e' ] }), hero());

		expect(result.merged.extensionIDs).toEqual([ 'e' ]);
		expect('picture' in result.merged).toBe(false);
	});

	it('merges conditions as a set by id', () => {
		const base = hero({ state: { conditions: [ condition('a'), condition('b') ] } });
		// The server removed a and added c; the saving device removed b and added d
		const current = hero({ state: { conditions: [ condition('b'), condition('c') ] } });
		const incoming = hero({ state: { conditions: [ condition('a'), condition('d') ] } });

		const merged = mergeHero(base, current, incoming).merged.state as { conditions: { id: string }[] };

		expect(merged.conditions.map(c => c.id)).toEqual([ 'd', 'c' ]);
	});

	it('keeps a condition the other side changed, even if this side removed it', () => {
		const base = hero({ state: { conditions: [ condition('a') ] } });
		const current = hero({ state: { conditions: [ condition('a', 'until the end of the encounter') ] } });
		const incoming = hero({ state: { conditions: [] } });

		const merged = mergeHero(base, current, incoming).merged.state as { conditions: { text: string }[] };

		expect(merged.conditions).toEqual([ condition('a', 'until the end of the encounter') ]);
	});

	it('keeps a remote heroic resource value inside a part the saving device changed', () => {
		const base = hero();
		const current = hero({ class: { featuresByLevel: [ { level: 1, features: [ resource(3) ] } ] } });
		const incoming = hero({ class: { level: 2 } });

		const result = mergeHero(base, current, incoming);

		expect((result.merged.class as JsonObject).level).toBe(2);
		expect(getResource(result.merged)).toBe(3);
	});

	it('combines heroic resource changes from both sides', () => {
		// The server's copy gained 3 and the saving device's gained 1, both from 0
		const current = hero({ class: { featuresByLevel: [ { level: 1, features: [ resource(3) ] } ] } });
		const incoming = hero({ class: { featuresByLevel: [ { level: 1, features: [ resource(1) ] } ] } });

		const result = mergeHero(hero(), current, incoming);

		expect(getResource(result.merged)).toBe(4);
	});

	it('returns the incoming hero unchanged when nothing else moved', () => {
		const incoming = hero({ state: { staminaDamage: 2 } });

		expect(mergeHero(hero(), hero(), incoming).merged).toEqual(incoming);
	});

	it('doesn\'t modify what it was given', () => {
		const base = hero();
		const current = hero({ class: { featuresByLevel: [ { level: 1, features: [ resource(3) ] } ] } });
		const incoming = hero({ class: { level: 2 } });
		const before = JSON.stringify([ base, current, incoming ]);

		mergeHero(base, current, incoming);

		expect(JSON.stringify([ base, current, incoming ])).toBe(before);
	});
});
