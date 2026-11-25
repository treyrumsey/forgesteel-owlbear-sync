import { type StampedHero } from '@/sync-steel/live/sync-steel-socket';

// Key order doesn't matter, matching the server's canonicalJson (server/src/json.ts)
const canonical = (value: unknown): string => {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(',')}]`;
	}
	if ((typeof value === 'object') && (value !== null)) {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.filter(key => object[key] !== undefined)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonical(object[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

// The same hero, ignoring the _syncSteel stamp
export const sameHeroContent = (a: StampedHero, b: StampedHero) => {
	const unstamped = (hero: StampedHero) => canonical({ ...hero, _syncSteel: undefined });
	return unstamped(a) === unstamped(b);
};
