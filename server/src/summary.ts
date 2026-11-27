import type { HeroSummary, HeroTokenPatch } from '@/sync-steel/logic/hero-summary-logic';
import type { JsonObject } from './json.ts';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Hero summaries for the Owlbear extension (report §4.9): the table stats Draw Steel Tools shows, and (Phase 5)
// the reverse, a token's edit written back into the hero. Both come from the fork's own HeroSummaryLogic,
// bundled with upstream's HeroLogic into server/build/hero-summary.mjs by vite.sync-steel-summary.config.ts,
// because Node can't run src/ directly. Tests pass the source instead.

export type { HeroSummary, HeroTokenPatch };

export interface SummaryTools {
	summarize: (hero: JsonObject) => HeroSummary;
	// Throws on a value or condition Forge Steel couldn't hold
	applyPatch: (hero: JsonObject, patch: HeroTokenPatch) => JsonObject;
}

interface SummaryModule {
	HeroSummaryLogic: {
		getSummary: (hero: never) => HeroSummary;
		applyTokenPatch: (hero: never, patch: HeroTokenPatch) => unknown;
	};
}

export const summaryToolsFrom = (module: SummaryModule): SummaryTools => {
	return {
		summarize: hero => module.HeroSummaryLogic.getSummary(hero as never),
		// Through JSON, so what's stored is plain data
		applyPatch: (hero, patch) => JSON.parse(JSON.stringify(module.HeroSummaryLogic.applyTokenPatch(hero as never, patch))) as JsonObject
	};
};

// Null when the bundle hasn't been built (local development); the hub then turns Owlbear connections away
export const loadSummaryTools = async (path: string): Promise<SummaryTools | null> => {
	if (!existsSync(path)) {
		return null;
	}
	const module = await import(pathToFileURL(path).href) as SummaryModule;
	if ((typeof module.HeroSummaryLogic?.getSummary !== 'function') || (typeof module.HeroSummaryLogic?.applyTokenPatch !== 'function')) {
		throw new Error(`${path} doesn't export HeroSummaryLogic.getSummary and applyTokenPatch. Rebuild it from the repository root with: npx vite build --config vite.sync-steel-summary.config.ts`);
	}
	return summaryToolsFrom(module);
};
