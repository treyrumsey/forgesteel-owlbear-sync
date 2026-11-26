import type { HeroSummary } from '@/sync-steel/logic/hero-summary-logic';
import type { JsonObject } from './json.ts';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Hero summaries for the Owlbear extension (report §4.9): the table stats Draw Steel Tools shows. They come
// from the fork's own HeroSummaryLogic, bundled with upstream's HeroLogic into server/build/hero-summary.mjs
// by vite.sync-steel-summary.config.ts, because Node can't run src/ directly. Tests pass the source instead.

export type { HeroSummary };

export type Summarize = (hero: JsonObject) => HeroSummary;

interface SummaryModule {
	HeroSummaryLogic: { getSummary: (hero: never) => HeroSummary };
}

export const summarizerFrom = (module: SummaryModule): Summarize => {
	return hero => module.HeroSummaryLogic.getSummary(hero as never);
};

// Null when the bundle hasn't been built (local development); the hub then turns Owlbear connections away
export const loadSummarizer = async (path: string): Promise<Summarize | null> => {
	if (!existsSync(path)) {
		return null;
	}
	const module = await import(pathToFileURL(path).href) as SummaryModule;
	if (typeof module.HeroSummaryLogic?.getSummary !== 'function') {
		throw new Error(`${path} doesn't export HeroSummaryLogic.getSummary`);
	}
	return summarizerFrom(module);
};
