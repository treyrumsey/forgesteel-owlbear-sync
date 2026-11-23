import * as DataContext from '@/contexts/data-context';
import { describe, expect, it } from 'vitest';
import { FactoryLogic } from '@/logic/factory-logic';
import { HeroLogic } from '@/logic/hero-logic';
import { Utils } from '@/utils/utils';
import analyticsSource from '@/utils/analytics.ts?raw';
import appFooterSource from '@/components/panels/app-footer/app-footer.tsx?raw';
import appRoutesSource from '@/components/main/app-routes.tsx?raw';
import { fury } from '@/data/classes/fury/fury';

// Contract tests (report §7): what Sync Steel relies on in upstream's code. The daily upstream merge
// runs these in CI, so an upstream change that breaks one stops the merge before it reaches players.
// The Warehouse client and the _syncSteel stamp have their own tests (server/src/warehouse-compat.test.ts,
// sync-steel-stamp.test.ts).

describe('upstream contracts Sync Steel relies on', () => {
	it('keeps the HeroLogic getters the Owlbear summary uses', () => {
		const hero = FactoryLogic.createHero();
		hero.class = Utils.copy(fury);
		hero.class.level = 1;

		expect(typeof HeroLogic.getStamina(hero)).toBe('number');
		expect(typeof HeroLogic.getRecoveries(hero)).toBe('number');
		expect(Array.isArray(HeroLogic.getHeroicResources(hero))).toBe(true);
		expect(Array.isArray(HeroLogic.getFeatures(hero))).toBe(true);
	});

	it('keeps the HeroState fields that sync to Owlbear', () => {
		const state = FactoryLogic.createHero().state;
		for (const field of [ 'staminaDamage', 'staminaTemp', 'recoveriesUsed', 'surges', 'victories', 'heroTokens' ] as const) {
			expect(typeof state[field], field).toBe('number');
		}
		expect(Array.isArray(state.conditions)).toBe(true);
	});

	it('keeps the data context entry points', () => {
		expect(typeof DataContext.useHeroes).toBe('function');
		expect(typeof DataContext.useDataManager).toBe('function');
		expect(typeof DataContext.DataManager.prototype.saveHero).toBe('function');
	});

	it('keeps the connection settings the Sync Steel page writes', () => {
		expect(Object.keys(FactoryLogic.createConnectionSettings()).sort()).toEqual([
			'dataSource',
			'patreonConnected',
			'patreonConnections',
			'usePatreonWarehouse',
			'useManualWarehouse',
			'warehouseHost',
			'warehouseToken'
		].sort());
	});

	// The only two upstream files Sync Steel edits: a merge mustn't silently drop the hooks
	it('keeps the Sync Steel route and footer button', () => {
		expect(appRoutesSource).toContain('import(\'@/sync-steel/components/sync-steel-page\')');
		expect(appRoutesSource).toMatch(/<Route path='sync-steel' element={<SyncSteelPage /);
		expect(appFooterSource).toContain('syncSteelFooterAction(isSmall),');
	});

	// The branded index.html swaps Google's tag for a no-op gtag (build/branding.ts). If upstream's
	// analytics stops using that global, the stub may no longer cover it: check before merging.
	it('keeps analytics on the global gtag that the branding stubs out', () => {
		expect(analyticsSource).toContain('declare let gtag:');
		expect(analyticsSource).not.toMatch(/window\.(gtag|dataLayer)|import .*gtag/);
	});
});
