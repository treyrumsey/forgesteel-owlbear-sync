import { ConditionEndType, ConditionType } from '@/enums/condition-type';
import { describe, expect, it } from 'vitest';
import { FactoryLogic } from '@/logic/factory-logic';
import { FeatureType } from '@/enums/feature-type';
import { Hero } from '@/models/hero';
import { HeroClass } from '@/models/class';
import { HeroLogic } from '@/logic/hero-logic';
import { HeroSummaryLogic } from '@/sync-steel/logic/hero-summary-logic';
import { Utils } from '@/utils/utils';
import { beastheart } from '@/data/classes/beastheart/beastheart';
import { fury } from '@/data/classes/fury/fury';
import { talent } from '@/data/classes/talent/talent';

const buildHero = (heroClass: HeroClass, level: number) => {
	const hero = FactoryLogic.createHero();
	hero.id = `${heroClass.id}-${level}`;
	hero.name = `${heroClass.name} ${level}`;
	hero.class = Utils.copy(heroClass);
	hero.class.level = level;
	return hero;
};

// Sets a resource the way the hero resources modal does: by feature id
const setResource = (hero: Hero, featureID: string, value: number) => {
	HeroLogic.getFeatures(hero, false)
		.map(f => f.feature)
		.filter(f => f.type === FeatureType.HeroicResource)
		.filter(f => f.id === featureID)
		.forEach(f => f.data.value = value);
};

describe('HeroSummaryLogic.getSummary', () => {
	it('maps a hero\'s state onto the Draw Steel Tools fields', () => {
		const hero = buildHero(fury, 1);
		hero.state.staminaDamage = 5;
		hero.state.staminaTemp = 3;
		hero.state.recoveriesUsed = 2;
		hero.state.surges = 1;
		hero.state.conditions = [
			{ id: 'c1', type: ConditionType.Bleeding, text: '', ends: ConditionEndType.SaveEnds }
		];
		setResource(hero, 'fury-resource', 4);

		expect(HeroSummaryLogic.getSummary(hero)).toEqual({
			heroId: 'class-fury-1',
			name: 'Fury 1',
			staminaMax: 21,
			stamina: 16,
			staminaTemp: 3,
			recoveriesMax: 10,
			recoveries: 8,
			surges: 1,
			resource: { featureId: 'fury-resource', name: 'Ferocity', value: 4 },
			conditions: [
				{ id: 'c1', type: ConditionType.Bleeding, text: '', ends: ConditionEndType.SaveEnds }
			]
		});
	});

	it('reports negative stamina for a dying hero', () => {
		const hero = buildHero(fury, 1);
		hero.state.staminaDamage = 25;

		expect(HeroSummaryLogic.getSummary(hero).stamina).toBe(-4);
	});

	it('picks Ferocity, not Rampage, as a Beastheart\'s primary resource', () => {
		const hero = buildHero(beastheart, 1);
		setResource(hero, 'beastheart-resource', 3);
		setResource(hero, 'beastheart-1-4', 5);

		expect(HeroLogic.getHeroicResources(hero).filter(r => r.type === 'heroic').map(r => r.id))
			.toEqual([ 'beastheart-resource', 'beastheart-1-4' ]);

		const summary = HeroSummaryLogic.getSummary(hero);
		expect(summary.resource).toEqual({ featureId: 'beastheart-resource', name: 'Ferocity', value: 3 });
		expect(summary.staminaMax).toBe(21);
		expect(summary.recoveriesMax).toBe(12);
	});

	it('keeps a Talent\'s negative Clarity', () => {
		const hero = buildHero(talent, 1);
		setResource(hero, 'talent-resource', -3);

		const summary = HeroSummaryLogic.getSummary(hero);
		expect(summary.resource).toEqual({ featureId: 'talent-resource', name: 'Clarity', value: -3 });
		expect(summary.staminaMax).toBe(18);
		expect(summary.recoveriesMax).toBe(8);
	});

	it('does not treat a level 10 hero\'s epic resource as primary', () => {
		const hero = buildHero(beastheart, 10);
		setResource(hero, 'beastheart-resource', 2);
		setResource(hero, 'beastheart-10-4', 7);

		expect(HeroLogic.getHeroicResources(hero).find(r => r.type === 'epic')?.id).toBe('beastheart-10-4');

		const summary = HeroSummaryLogic.getSummary(hero);
		expect(summary.resource).toEqual({ featureId: 'beastheart-resource', name: 'Ferocity', value: 2 });
		expect(summary.staminaMax).toBe(21 + (12 * 9));
	});

	it('summarises a hero with no class without a resource', () => {
		const summary = HeroSummaryLogic.getSummary(FactoryLogic.createHero());

		expect(summary.resource).toBeNull();
		expect(summary.staminaMax).toBe(0);
		expect(summary.stamina).toBe(0);
		expect(summary.recoveries).toBe(0);
	});

	// Draw Steel Tools' parseTokenData throws on non-numbers, which would break the token
	it('replaces missing or non-finite values with 0', () => {
		const hero = buildHero(fury, 1);
		(hero.state as { staminaTemp?: number }).staminaTemp = undefined;
		hero.state.surges = NaN;
		hero.state.recoveriesUsed = Infinity;

		const summary = HeroSummaryLogic.getSummary(hero);
		expect(summary.staminaTemp).toBe(0);
		expect(summary.surges).toBe(0);
		expect(summary.recoveries).toBe(10);
	});
});

describe('HeroSummaryLogic.applyTokenPatch', () => {
	const bleeding = { id: 'c1', type: ConditionType.Bleeding, text: '', ends: ConditionEndType.SaveEnds };

	it('writes each Draw Steel Tools value back into the hero\'s state', () => {
		const hero = buildHero(fury, 1);
		const patched = HeroSummaryLogic.applyTokenPatch(hero, {
			values: { stamina: 16, temporaryStamina: 3, recoveries: 8, surges: 2, heroicResource: 4 }
		});

		expect(patched.state.staminaDamage).toBe(5);
		expect(patched.state.staminaTemp).toBe(3);
		expect(patched.state.recoveriesUsed).toBe(2);
		expect(patched.state.surges).toBe(2);
		expect(HeroSummaryLogic.getSummary(patched)).toMatchObject({
			stamina: 16, staminaTemp: 3, recoveries: 8, surges: 2, resource: { featureId: 'fury-resource', value: 4 }
		});
		// The original is untouched
		expect(hero.state.staminaDamage).toBe(0);
	});

	it('round-trips a summary', () => {
		const hero = buildHero(beastheart, 10);
		hero.state.staminaDamage = 40;
		hero.state.recoveriesUsed = 3;
		setResource(hero, 'beastheart-resource', 5);
		const summary = HeroSummaryLogic.getSummary(hero);

		const patched = HeroSummaryLogic.applyTokenPatch(hero, {
			values: { stamina: summary.stamina, temporaryStamina: summary.staminaTemp, recoveries: summary.recoveries, surges: summary.surges, heroicResource: summary.resource!.value }
		});
		expect(patched).toEqual(hero);
	});

	it('changes only the values given', () => {
		const hero = buildHero(fury, 1);
		hero.state.staminaDamage = 7;
		hero.state.surges = 1;

		const patched = HeroSummaryLogic.applyTokenPatch(hero, { values: { surges: 3 } });
		expect(patched.state.staminaDamage).toBe(7);
		expect(patched.state.surges).toBe(3);
	});

	it('allows negative stamina (dying) and keeps values in range', () => {
		const hero = buildHero(fury, 1);

		expect(HeroSummaryLogic.applyTokenPatch(hero, { values: { stamina: -4 } }).state.staminaDamage).toBe(25);
		expect(HeroSummaryLogic.applyTokenPatch(hero, { values: { stamina: 30 } }).state.staminaDamage).toBe(0);
		expect(HeroSummaryLogic.applyTokenPatch(hero, { values: { recoveries: 12 } }).state.recoveriesUsed).toBe(0);
		expect(HeroSummaryLogic.applyTokenPatch(hero, { values: { recoveries: -1 } }).state.recoveriesUsed).toBe(10);
		expect(HeroSummaryLogic.applyTokenPatch(hero, { values: { temporaryStamina: -2, surges: -1 } }).state).toMatchObject({ staminaTemp: 0, surges: 0 });
		expect(HeroSummaryLogic.applyTokenPatch(hero, { values: { surges: 2.6 } }).state.surges).toBe(3);
	});

	it('keeps a Talent\'s negative Clarity', () => {
		const hero = buildHero(talent, 1);

		const patched = HeroSummaryLogic.applyTokenPatch(hero, { values: { heroicResource: -3 } });
		expect(HeroSummaryLogic.getSummary(patched).resource).toEqual({ featureId: 'talent-resource', name: 'Clarity', value: -3 });
	});

	it('sets a Beastheart\'s Ferocity, not Rampage or the epic resource', () => {
		const hero = buildHero(beastheart, 10);
		setResource(hero, 'beastheart-1-4', 5);
		setResource(hero, 'beastheart-10-4', 7);

		const patched = HeroSummaryLogic.applyTokenPatch(hero, { values: { heroicResource: 2 } });
		const values = Object.fromEntries(HeroLogic.getHeroicResources(patched).map(r => [ r.id, r.value ]));
		expect(values).toMatchObject({ 'beastheart-resource': 2, 'beastheart-1-4': 5, 'beastheart-10-4': 7 });
	});

	it('ignores a heroic resource for a hero without one', () => {
		const hero = FactoryLogic.createHero();

		expect(HeroSummaryLogic.applyTokenPatch(hero, { values: { heroicResource: 3 } })).toEqual(hero);
	});

	it('adds and removes conditions by id', () => {
		const hero = buildHero(fury, 1);
		hero.state.conditions = [ bleeding ];
		const slowed = { id: 'c2', type: ConditionType.Slowed, text: '', ends: ConditionEndType.EndOfTurn };

		const patched = HeroSummaryLogic.applyTokenPatch(hero, { conditions: { add: [ slowed, bleeding ], remove: [ 'c1', 'gone' ] } });
		expect(patched.state.conditions).toEqual([ slowed ]);

		const custom = { id: 'c3', type: ConditionType.Custom, text: 'Marked', ends: ConditionEndType.UntilRemoved };
		expect(HeroSummaryLogic.applyTokenPatch(hero, { conditions: { add: [ custom ] } }).state.conditions).toEqual([ bleeding, custom ]);
	});

	it.each([
		[ 'a non-number', { values: { stamina: 'x' as unknown as number } } ],
		[ 'NaN', { values: { surges: NaN } } ],
		[ 'an unknown condition type', { conditions: { add: [ { ...bleeding, type: 'Sleepy' as ConditionType } ] } } ],
		[ 'an unknown condition end', { conditions: { add: [ { ...bleeding, ends: 'EoT' as ConditionEndType } ] } } ],
		[ 'a condition without an id', { conditions: { add: [ { ...bleeding, id: '' } ] } } ]
	])('rejects %s', (_name, patch) => {
		expect(() => HeroSummaryLogic.applyTokenPatch(buildHero(fury, 1), patch)).toThrow();
	});
});
