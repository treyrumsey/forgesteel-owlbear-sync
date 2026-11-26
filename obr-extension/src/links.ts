import type { HeroSummary, SummaryCondition } from './summary.ts';
import { LINK_KEY } from './keys.ts';

// A token's link to a hero, kept on the token itself under LINK_KEY, so it travels with the token into
// every scene (including Party Continuity's copies). The extension writes it with the token's DST stats.

export interface TokenLink {
	heroId: string;
	// The hero revision whose stats were last written to the token; 0 until the first write
	syncedRev: number;
	// Copied from the summary, so every client can draw badges without a connection to the api
	conditions: SummaryCondition[];
}

export const readLink = (metadata: Record<string, unknown>): TokenLink | null => {
	const value = metadata[LINK_KEY];
	if ((typeof value !== 'object') || (value === null)) {
		return null;
	}
	const link = value as Record<string, unknown>;
	if ((typeof link.heroId !== 'string') || !link.heroId) {
		return null;
	}
	return {
		heroId: link.heroId,
		syncedRev: Number.isInteger(link.syncedRev) ? link.syncedRev as number : 0,
		conditions: Array.isArray(link.conditions)
			? (link.conditions as SummaryCondition[]).filter(c => (typeof c === 'object') && (c !== null) && (typeof c.id === 'string'))
			: []
	};
};

export const newLink = (heroId: string): TokenLink => ({ heroId: heroId, syncedRev: 0, conditions: [] });

export const linkFor = (summary: HeroSummary): TokenLink => ({
	heroId: summary.heroId,
	syncedRev: summary.rev,
	conditions: summary.conditions.map(c => ({ id: c.id, type: c.type, text: c.text, ends: c.ends }))
});

export const sameLink = (a: TokenLink | null, b: TokenLink | null) => JSON.stringify(a) === JSON.stringify(b);

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The picker's order: heroes whose name matches the token's first, then by name
export const rankHeroes = (tokenName: string, heroes: HeroSummary[]) => {
	const token = normalize(tokenName);
	const score = (hero: HeroSummary) => {
		const name = normalize(hero.name);
		if (!token || !name) {
			return 0;
		}
		if (name === token) {
			return 3;
		}
		if (name.split(' ')[0] === token.split(' ')[0]) {
			return 2;
		}
		return (name.includes(token) || token.includes(name)) ? 1 : 0;
	};
	return heroes
		.map(hero => ({ hero: hero, score: score(hero) }))
		.sort((a, b) => (b.score - a.score) || a.hero.name.localeCompare(b.hero.name))
		.map(entry => ({ hero: entry.hero, match: entry.score > 0 }));
};
