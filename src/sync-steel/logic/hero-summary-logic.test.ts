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
