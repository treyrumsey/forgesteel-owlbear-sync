import { Condition } from '@/models/condition';
import { Hero } from '@/models/hero';
import { HeroLogic } from '@/logic/hero-logic';
import { Utils } from '@/utils/utils';

export interface HeroSummaryResource {
	featureId: string;
	name: string;
	value: number;
}

// The table stats sent to the Owlbear extension (report §4.5, field mapping §4.9)
export interface HeroSummary {
	heroId: string;
	name: string;
	staminaMax: number;
	stamina: number;
	staminaTemp: number;
	recoveriesMax: number;
	recoveries: number;
	surges: number;
	resource: HeroSummaryResource | null;
	conditions: Condition[];
}

export class HeroSummaryLogic {
	// Same rule HeroLogic.getHeroicResources uses for resource gains: the first 'heroic' resource.
	// Epic resources and any second heroic resource (e.g. the Beastheart's Rampage) are not primary.
	static getPrimaryHeroicResource = (hero: Hero): HeroSummaryResource | null => {
		const resource = HeroLogic.getHeroicResources(hero).find(r => r.type === 'heroic');
		if (!resource) {
			return null;
		}

		return {
			featureId: resource.id,
			name: resource.name,
			value: HeroSummaryLogic.toFinite(resource.value)
		};
	};

	static getSummary = (hero: Hero): HeroSummary => {
		const staminaMax = HeroSummaryLogic.toFinite(HeroLogic.getStamina(hero));
		const recoveriesMax = HeroSummaryLogic.toFinite(HeroLogic.getRecoveries(hero));

		return {
			heroId: hero.id,
			name: hero.name,
			staminaMax: staminaMax,
			stamina: staminaMax - HeroSummaryLogic.toFinite(hero.state.staminaDamage),
			staminaTemp: HeroSummaryLogic.toFinite(hero.state.staminaTemp),
			recoveriesMax: recoveriesMax,
			recoveries: recoveriesMax - HeroSummaryLogic.toFinite(hero.state.recoveriesUsed),
			surges: HeroSummaryLogic.toFinite(hero.state.surges),
			resource: HeroSummaryLogic.getPrimaryHeroicResource(hero),
			conditions: Utils.copy(hero.state.conditions ?? [])
		};
	};

	// Draw Steel Tools throws on token data that fails its schema, so never emit NaN / Infinity / undefined
	private static toFinite = (value: number | null | undefined) => {
		return (typeof value === 'number') && Number.isFinite(value) ? value : 0;
	};
}
