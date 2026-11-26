import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { FactoryLogic } from '@/logic/factory-logic';
import type { HeroClass } from '@/models/class';
import { HeroSummaryLogic } from '@/sync-steel/logic/hero-summary-logic';
import type { JsonObject } from './json.ts';
import type { Summarize } from './summary.ts';
import { Utils } from '@/utils/utils';
import { beastheart } from '@/data/classes/beastheart/beastheart';
import { build } from 'vite';
import { fury } from '@/data/classes/fury/fury';
import { join } from 'node:path';
import { loadSummarizer } from './summary.ts';
import { talent } from '@/data/classes/talent/talent';
import { tmpdir } from 'node:os';

// The api runs the bundle that vite.sync-steel-summary.config.ts builds, not the source. This builds it the way
// server/Dockerfile does and checks it gives the same summaries as the source.

let dir: string;
let summarize: Summarize | null;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'sync-steel-summary-'));
	await build({ configFile: 'vite.sync-steel-summary.config.ts', logLevel: 'silent', build: { outDir: dir } });
	summarize = await loadSummarizer(join(dir, 'hero-summary.mjs'));
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
		expect(summarize).not.toBeNull();
	});

	it.each([
		[ 'a Fury', fury, 1 ],
		[ 'a Beastheart', beastheart, 10 ],
		[ 'a Talent', talent, 1 ]
	])('summarises %s as the source does', (_name, heroClass, level) => {
		const hero = heroJson(heroClass, level);

		expect(summarize!(hero)).toEqual(HeroSummaryLogic.getSummary(hero as never));
	});

	it('returns null when there is no bundle', async () => {
		expect(await loadSummarizer(join(dir, 'missing.mjs'))).toBeNull();
	});
});
