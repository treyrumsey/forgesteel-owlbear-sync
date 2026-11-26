import { DST_METADATA_KEY, type DstHeroTokenData, SYNCED_FIELDS, patchDstHeroData, readDstToken, summaryToDstPatch } from './dst-token.ts';
import { type TokenLink, linkFor, readLink, sameLink } from './links.ts';
import type { HeroSummary } from './summary.ts';
import { LINK_KEY } from './keys.ts';

// What one token write changes, worked out on the fresh copy Owlbear hands the updater (report §4.8: "diff on
// the fresh read"). Only DST's synced fields and our own link are touched; DST's notes, gmOnly and
// heroicResourceButton stay as they are.

export type TokenUpdate =
	| { kind: 'write', dst: DstHeroTokenData, link: TokenLink }
	| { kind: 'unchanged' }
	| { kind: 'skip', reason: string };

export const planTokenUpdate = (metadata: Record<string, unknown>, summary: HeroSummary): TokenUpdate => {
	const current = readLink(metadata);
	if (current?.heroId !== summary.heroId) {
		return { kind: 'skip', reason: 'the token is no longer linked to this hero' };
	}

	const read = readDstToken(metadata);
	if (read.kind === 'other') {
		return { kind: 'skip', reason: `it's a Draw Steel Tools ${read.type} token, not a hero` };
	}
	if (read.kind === 'invalid') {
		return { kind: 'skip', reason: `its Draw Steel Tools data is invalid: ${read.problems.join('; ')}` };
	}
	// A linked token without DST data becomes a DST hero token
	const existing: DstHeroTokenData = read.kind === 'hero' ? read.data : { type: 'HERO' };
	const patched = patchDstHeroData(existing, summaryToDstPatch(summary));
	if (!patched.ok) {
		return { kind: 'skip', reason: patched.problems.join('; ') };
	}

	const link = linkFor(summary);
	if ((read.kind === 'hero') && (patched.changed.length === 0) && sameLink(current, link)) {
		return { kind: 'unchanged' };
	}
	return { kind: 'write', dst: patched.data, link: link };
};

// Applies a planned write to an Owlbear item's metadata draft
export const applyTokenUpdate = (metadata: Record<string, unknown>, update: Extract<TokenUpdate, { kind: 'write' }>) => {
	metadata[DST_METADATA_KEY] = update.dst;
	metadata[LINK_KEY] = update.link;
};

type SyncedValues = Partial<Record<typeof SYNCED_FIELDS[number], unknown>>;

export const syncedValues = (metadata: Record<string, unknown>): SyncedValues => {
	const read = readDstToken(metadata);
	const data = read.kind === 'hero' ? read.data : {};
	return Object.fromEntries(SYNCED_FIELDS.map(field => [ field, data[field] ]));
};

// Fields our write changed that are back at their value from before it: DST saving an older copy right after
// our write (spike finding 8), not a person's edit. The writer writes them again.
export const clobberedFields = (before: SyncedValues, written: SyncedValues, now: SyncedValues) => {
	return SYNCED_FIELDS.filter(field => (written[field] !== before[field]) && (now[field] === before[field]) && (now[field] !== written[field]));
};
