import { DST_METADATA_KEY, type DstHeroTokenData } from './dst-token.ts';
import { applyTokenUpdate, clobberedFields, planTokenUpdate, syncedValues } from './token-update.ts';
import { describe, expect, it } from 'vitest';
import { linkFor, newLink, rankHeroes, readLink } from './links.ts';
import type { HeroSummary } from './summary.ts';
import { LINK_KEY } from './keys.ts';
import { electWriter } from './election.ts';
import { readSummary } from './summary.ts';

const summary = (overrides: Partial<HeroSummary> = {}): HeroSummary => ({
	heroId: 'hero-1',
	rev: 4,
	seatName: 'Alice',
	name: 'Kalla',
	staminaMax: 21,
	stamina: 16,
	staminaTemp: 3,
	recoveriesMax: 10,
	recoveries: 9,
	surges: 1,
	resource: { featureId: 'fury-resource', name: 'Ferocity', value: 2 },
	conditions: [ { id: 'c1', type: 'Bleeding', text: '', ends: 'Save ends' } ],
	...overrides
});

const tableSettings: DstHeroTokenData = { type: 'HERO', notes: 'Owes Bob', gmOnly: true, heroicResourceButton: 'D3+1' };

describe('planTokenUpdate', () => {
	it('writes the synced DST fields and the link, keeping the table\'s own DST settings', () => {
		const metadata: Record<string, unknown> = { [DST_METADATA_KEY]: { ...tableSettings, stamina: 21 }, [LINK_KEY]: newLink('hero-1') };

		const update = planTokenUpdate(metadata, summary());
		expect(update.kind).toBe('write');
		applyTokenUpdate(metadata, update as Extract<typeof update, { kind: 'write' }>);

		expect(metadata[DST_METADATA_KEY]).toEqual({
			...tableSettings,
			name: 'Kalla',
			stamina: 16,
			staminaMaximum: 21,
			temporaryStamina: 3,
			recoveries: 9,
			surges: 1,
			heroicResource: 2,
			heroicResourceName: 'Ferocity'
		});
		expect(readLink(metadata)).toEqual({ heroId: 'hero-1', syncedRev: 4, conditions: summary().conditions });
	});

	it('skips a write that changes nothing', () => {
		const metadata: Record<string, unknown> = { [LINK_KEY]: newLink('hero-1') };
		const first = planTokenUpdate(metadata, summary());
		applyTokenUpdate(metadata, first as Extract<typeof first, { kind: 'write' }>);

		expect(planTokenUpdate(metadata, summary())).toEqual({ kind: 'unchanged' });
		expect(planTokenUpdate(metadata, summary({ rev: 5 })).kind).toBe('write');
	});

	it('makes a linked token without DST data a DST hero token', () => {
		const update = planTokenUpdate({ [LINK_KEY]: newLink('hero-1') }, summary());

		expect(update).toMatchObject({ kind: 'write', dst: { type: 'HERO', stamina: 16 } });
	});

	it('leaves DST\'s resource fields alone for a hero without a heroic resource', () => {
		const metadata = { [DST_METADATA_KEY]: { heroicResource: 5, heroicResourceName: 'Piety' }, [LINK_KEY]: newLink('hero-1') };

		expect(planTokenUpdate(metadata, summary({ resource: null }))).toMatchObject({ dst: { heroicResource: 5, heroicResourceName: 'Piety' } });
	});

	it('skips tokens it mustn\'t write', () => {
		expect(planTokenUpdate({ [LINK_KEY]: newLink('hero-2') }, summary()).kind).toBe('skip');
		expect(planTokenUpdate({}, summary()).kind).toBe('skip');
		expect(planTokenUpdate({ [LINK_KEY]: newLink('hero-1'), [DST_METADATA_KEY]: { type: 'MONSTER' } }, summary()).kind).toBe('skip');
		expect(planTokenUpdate({ [LINK_KEY]: newLink('hero-1'), [DST_METADATA_KEY]: { stamina: 'lots' } }, summary()).kind).toBe('skip');
	});
});

describe('clobberedFields', () => {
	it('finds fields DST put back to their value from before our write', () => {
		const before = syncedValues({ [DST_METADATA_KEY]: { stamina: 33, surges: 2 } });
		const written = syncedValues({ [DST_METADATA_KEY]: { stamina: 32, surges: 2 } });

		expect(clobberedFields(before, written, syncedValues({ [DST_METADATA_KEY]: { stamina: 33, surges: 3 } }))).toEqual([ 'stamina' ]);
		expect(clobberedFields(before, written, syncedValues({ [DST_METADATA_KEY]: { stamina: 30, surges: 2 } }))).toEqual([]);
	});
});

describe('links', () => {
	it('reads only a well-formed link', () => {
		expect(readLink({ [LINK_KEY]: { heroId: 'h', syncedRev: 'x' } })).toEqual({ heroId: 'h', syncedRev: 0, conditions: [] });
		expect(readLink({ [LINK_KEY]: { heroId: '' } })).toBeNull();
		expect(readLink({})).toBeNull();
		expect(linkFor(summary())).toEqual({ heroId: 'hero-1', syncedRev: 4, conditions: summary().conditions });
	});

	it('puts heroes whose name matches the token first', () => {
		const heroes = [ summary({ heroId: 'a', name: 'Vex' }), summary({ heroId: 'b', name: 'Kalla the Fury' }), summary({ heroId: 'c', name: 'Ash' }) ];

		expect(rankHeroes('Kalla', heroes).map(entry => [ entry.hero.name, entry.match ])).toEqual([
			[ 'Kalla the Fury', true ],
			[ 'Ash', false ],
			[ 'Vex', false ]
		]);
	});
});

describe('electWriter', () => {
	it('picks a GM first, then the lowest connection id', () => {
		expect(electWriter([
			{ connectionId: 'b', role: 'PLAYER', name: 'TV' },
			{ connectionId: 'c', role: 'GM', name: 'GM laptop' },
			{ connectionId: 'a', role: 'GM', name: 'GM iPad' }
		])?.name).toBe('GM iPad');
		expect(electWriter([ { connectionId: 'z', role: 'PLAYER', name: 'Remote' }, { connectionId: 'b', role: 'PLAYER', name: 'TV' } ])?.name).toBe('TV');
		expect(electWriter([])).toBeNull();
	});
});

describe('readSummary', () => {
	it('accepts the hub\'s summary and rejects anything DST couldn\'t take', () => {
		expect(readSummary(summary())).toEqual(summary());
		expect(readSummary({ ...summary(), stamina: null })).toBeNull();
		expect(readSummary({ ...summary(), resource: { name: 'x' } })?.resource).toBeNull();
	});
});
