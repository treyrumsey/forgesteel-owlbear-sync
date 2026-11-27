import { CONDITION_ENDS, CONDITION_TYPES } from '../../obr-extension/src/conditions.ts';
import { ConditionEndType, ConditionType } from '@/enums/condition-type';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { FactoryLogic } from '@/logic/factory-logic';
import type { HeroClass } from '@/models/class';
import { HeroSummaryLogic } from '@/sync-steel/logic/hero-summary-logic';
import type { JsonObject } from './json.ts';
import type { SummaryTools } from './summary.ts';
import { Utils } from '@/utils/utils';
import { beastheart } from '@/data/classes/beastheart/beastheart';
import { build } from 'vite';
import { fury } from '@/data/classes/fury/fury';
import { join } from 'node:path';
import { loadSummaryTools } from './summary.ts';
import { talent } from '@/data/classes/talent/talent';
import { tmpdir } from 'node:os';

// The api runs the bundle that vite.sync-steel-summary.config.ts builds, not the source. This builds it the way
// server/Dockerfile does and checks it gives the same summaries as the source.

let dir: string;
let tools: SummaryTools | null;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'sync-steel-summary-'));
	await build({ configFile: 'vite.sync-steel-summary.config.ts', logLevel: 'silent', build: { outDir: dir } });
	tools = await loadSummaryTools(join(dir, 'hero-summary.mjs'));
}, 60_000);

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

const heroJson = (heroClass: HeroClass, level: number) => {
	const hero = FactoryLogic.createHero();
	hero.id = `${heroClass.id}-${level}`;
	hero.name = `${heroClass.name} ${level}`;
	hero.class = Utils.copy(heroClass);
	hero.class.level = level;
	hero.state.staminaDamage = 4;
	hero.state.recoveriesUsed = 1;
	// The api reads heroes from the database as JSON
	return JSON.parse(JSON.stringify(hero)) as JsonObject;
};

describe('the hero summary bundle', () => {
	it('loads', () => {
		expect(tools).not.toBeNull();
	});

	it.each([
		[ 'a Fury', fury, 1 ],
		[ 'a Beastheart', beastheart, 10 ],
		[ 'a Talent', talent, 1 ]
	])('summarises %s as the source does', (_name, heroClass, level) => {
		const hero = heroJson(heroClass, level);

		expect(tools!.summarize(hero)).toEqual(HeroSummaryLogic.getSummary(hero as never));
	});

	it.each([
		[ 'a Fury', fury, 1 ],
		[ 'a Beastheart', beastheart, 10 ],
		[ 'a Talent', talent, 1 ]
	])('applies a token patch to %s as the source does', (_name, heroClass, level) => {
		const hero = heroJson(heroClass, level);
		const patch = {
			values: { stamina: 3, temporaryStamina: 2, recoveries: 1, surges: 2, heroicResource: -1 },
			conditions: { add: [ { id: 'c1', type: ConditionType.Dazed, text: '', ends: ConditionEndType.SaveEnds } ] }
		};

		const fromBundle = tools!.applyPatch(hero, patch);
		expect(fromBundle).toEqual(JSON.parse(JSON.stringify(HeroSummaryLogic.applyTokenPatch(hero as never, patch))));
		expect(tools!.summarize(fromBundle)).toMatchObject({ stamina: 3, staminaTemp: 2, recoveries: 1, surges: 2, resource: { value: -1 } });
	});

	// The extension's Conditions menu offers its own copy of the list, which the bundle checks
	it('accepts every condition the extension offers', () => {
		expect([ ...CONDITION_TYPES ].sort()).toEqual(Object.values(ConditionType).sort());
		expect(CONDITION_ENDS.map(end => end.value).sort()).toEqual(Object.values(ConditionEndType).sort());
	});

	it('returns null when there is no bundle', async () => {
		expect(await loadSummaryTools(join(dir, 'missing.mjs'))).toBeNull();
	});
});
