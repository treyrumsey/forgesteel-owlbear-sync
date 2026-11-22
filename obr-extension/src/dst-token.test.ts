import { DST_METADATA_KEY, type DstHeroTokenData, patchDstHeroData, readDstToken, summaryToDstPatch } from './dst-token.ts';
import { describe, expect, it } from 'vitest';

const heroData: DstHeroTokenData = {
	type: 'HERO',
	name: 'Kalla',
	gmOnly: true,
	stamina: 20,
	staminaMaximum: 33,
	temporaryStamina: 0,
	heroicResource: 2,
	recoveries: 8,
	surges: 0,
	heroicResourceButton: 'D3+1',
	heroicResourceName: 'Ferocity',
	notes: 'Owes the guild 3 gold'
};

describe('readDstToken', () => {
	it('reads hero data, including older tokens without a type', () => {
		const untyped: DstHeroTokenData = { ...heroData };
		delete untyped.type;

		expect(readDstToken({ [DST_METADATA_KEY]: heroData })).toEqual({ kind: 'hero', data: heroData });
		expect(readDstToken({ [DST_METADATA_KEY]: untyped }).kind).toBe('hero');
	});

	it('leaves monsters, minions and tokens without DST data alone', () => {
		expect(readDstToken({ [DST_METADATA_KEY]: { type: 'MINION', groupId: 'g' } })).toEqual({ kind: 'other', type: 'MINION' });
		expect(readDstToken({ 'other-extension/metadata': {} })).toEqual({ kind: 'none' });
	});

	it('reports data that DST itself would fail to parse', () => {
		const result = readDstToken({ [DST_METADATA_KEY]: { ...heroData, stamina: null, heroicResourceButton: 'D6' } });

		expect(result.kind).toBe('invalid');
	});
});

describe('patchDstHeroData', () => {
	it('writes only synced fields and keeps notes, gmOnly and heroicResourceButton', () => {
		const result = patchDstHeroData(heroData, { stamina: 12, heroicResource: -3, heroicResourceName: 'Clarity' });

		expect(result).toEqual({
			ok: true,
			data: { ...heroData, stamina: 12, heroicResource: -3, heroicResourceName: 'Clarity' },
			changed: [ 'stamina', 'heroicResource', 'heroicResourceName' ]
		});
	});

	it('reports no changes when the token already has the values, so the write can be skipped', () => {
		const result = patchDstHeroData(heroData, { stamina: 20, surges: 0 });

		expect(result.ok && result.changed).toEqual([]);
	});

	it('refuses values DST would reject', () => {
		expect(patchDstHeroData(heroData, { stamina: NaN }).ok).toBe(false);
		expect(patchDstHeroData(heroData, { recoveries: Infinity }).ok).toBe(false);
		expect(patchDstHeroData(heroData, { surges: '2' as unknown as number }).ok).toBe(false);
		expect(patchDstHeroData(heroData, { name: null as unknown as string }).ok).toBe(false);
	});

	it('refuses to write fields that belong to the table', () => {
		const result = patchDstHeroData(heroData, { notes: 'overwritten' } as never);

		expect(result).toEqual({ ok: false, problems: [ 'notes is not a field Sync Steel writes' ] });
	});
});

describe('summaryToDstPatch', () => {
	it('maps a summary onto DST fields', () => {
		const patch = summaryToDstPatch({
			name: 'Garrick',
			staminaMax: 18,
			stamina: -2,
			staminaTemp: 3,
			recoveries: 6,
			surges: 1,
			resource: { name: 'Clarity', value: -3 }
		});

		expect(patch).toEqual({
			name: 'Garrick',
			staminaMaximum: 18,
			stamina: -2,
			temporaryStamina: 3,
			recoveries: 6,
			surges: 1,
			heroicResource: -3,
			heroicResourceName: 'Clarity'
		});
		expect(patchDstHeroData(heroData, patch).ok).toBe(true);
	});

	it('leaves the resource fields alone for a hero without a heroic resource', () => {
		const patch = summaryToDstPatch({ name: 'Nobody', staminaMax: 0, stamina: 0, staminaTemp: 0, recoveries: 0, surges: 0, resource: null });

		expect(patch).not.toHaveProperty('heroicResource');
		expect(patch).not.toHaveProperty('heroicResourceName');
	});
});
