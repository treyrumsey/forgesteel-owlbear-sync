import { ConditionEndType, ConditionType } from '@/enums/condition-type';
import { Condition } from '@/models/condition';
import { FeatureType } from '@/enums/feature-type';
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

// An edit made in Owlbear (Phase 5): the token's new Draw Steel Tools values, in its own terms, and conditions
// added or removed with the extension's Conditions menu. Each value is optional; only those given change.
export interface HeroTokenPatch {
	values?: {
		stamina?: number;
		temporaryStamina?: number;
		recoveries?: number;
		surges?: number;
		heroicResource?: number;
	};
	conditions?: {
		add?: Condition[];
		remove?: string[];
	};
}

const CONDITION_TYPES = new Set<string>(Object.values(ConditionType));
const CONDITION_END_TYPES = new Set<string>(Object.values(ConditionEndType));

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

	// The reverse of getSummary (report §4.9): a copy of the hero with the token's values written back into
	// its state. The server applies this to the revision the token was synced at and merges the result
	// (server/src/merge.ts), so counters combine with anything Forge Steel changed meanwhile.
	// Throws on a value or condition Forge Steel couldn't hold.
	static applyTokenPatch = (hero: Hero, patch: HeroTokenPatch): Hero => {
		const copy = Utils.copy(hero);
		const values = patch.values ?? {};
		const whole = (name: string, value: number | undefined) => {
			if (value === undefined) {
				return undefined;
			}
			if ((typeof value !== 'number') || !Number.isFinite(value)) {
				throw new Error(`${name} must be a number`);
			}
			return Math.round(value);
		};

		const stamina = whole('stamina', values.stamina);
		if (stamina !== undefined) {
			// Negative stamina (dying) is allowed; more than the maximum isn't damage
			const staminaMax = HeroSummaryLogic.toFinite(HeroLogic.getStamina(copy));
			copy.state.staminaDamage = Math.max(0, staminaMax - stamina);
		}
		const temporaryStamina = whole('temporaryStamina', values.temporaryStamina);
		if (temporaryStamina !== undefined) {
			copy.state.staminaTemp = Math.max(0, temporaryStamina);
		}
		const recoveries = whole('recoveries', values.recoveries);
		if (recoveries !== undefined) {
			// Draw Steel Tools stores the recoveries left
			const recoveriesMax = HeroSummaryLogic.toFinite(HeroLogic.getRecoveries(copy));
			copy.state.recoveriesUsed = Math.min(recoveriesMax, Math.max(0, recoveriesMax - recoveries));
		}
		const surges = whole('surges', values.surges);
		if (surges !== undefined) {
			copy.state.surges = Math.max(0, surges);
		}
		const heroicResource = whole('heroicResource', values.heroicResource);
		if (heroicResource !== undefined) {
			// Set by feature id, as the hero resources modal does; a hero without one ignores it
			const resource = HeroSummaryLogic.getPrimaryHeroicResource(copy);
			if (resource) {
				HeroLogic.getFeatures(copy, false)
					.map(f => f.feature)
					.filter(f => f.type === FeatureType.HeroicResource)
					.filter(f => f.id === resource.featureId)
					.forEach(f => f.data.value = heroicResource);
			}
		}

		if (patch.conditions) {
			const remove = new Set(patch.conditions.remove ?? []);
			const conditions = (copy.state.conditions ?? []).filter(c => !remove.has(c.id));
			(patch.conditions.add ?? []).forEach(condition => {
				HeroSummaryLogic.checkCondition(condition);
				if (!remove.has(condition.id) && !conditions.some(c => c.id === condition.id)) {
					conditions.push({ id: condition.id, type: condition.type, text: condition.text, ends: condition.ends });
				}
			});
			copy.state.conditions = conditions;
		}

		return copy;
	};

	private static checkCondition = (condition: Condition) => {
		if ((typeof condition !== 'object') || (condition === null)) {
			throw new Error('A condition must be an object');
		}
		if ((typeof condition.id !== 'string') || (condition.id.length === 0) || (condition.id.length > 100)) {
			throw new Error('A condition needs an id');
		}
		if (!CONDITION_TYPES.has(condition.type)) {
			throw new Error(`Unknown condition type ${String(condition.type)}`);
		}
		if (!CONDITION_END_TYPES.has(condition.ends)) {
			throw new Error(`Unknown condition end ${String(condition.ends)}`);
		}
		if ((typeof condition.text !== 'string') || (condition.text.length > 200)) {
			throw new Error('A condition\'s text must be a short string');
		}
	};

	// Draw Steel Tools throws on token data that fails its schema, so never emit NaN / Infinity / undefined
	private static toFinite = (value: number | null | undefined) => {
		return (typeof value === 'number') && Number.isFinite(value) ? value : 0;
	};
}
