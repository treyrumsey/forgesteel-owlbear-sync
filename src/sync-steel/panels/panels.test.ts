import { LIVE_PANELS, livePanelFiles, redirectFor } from '@/sync-steel/build/live-panels';
import { LIVE_PANEL_COPIES, liveCopy } from '@/sync-steel/panels/live-copy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LivePanels } from '@/sync-steel/panels/live-panels';
import { RemoteHeroes } from '@/sync-steel/live/remote-heroes';
import type { StampedHero } from '@/sync-steel/live/sync-steel-socket';
import inventoryCopy from '@/sync-steel/panels/copies/hero-inventory-modal.tsx?raw';
import inventoryUpstream from '@/components/modals/hero-inventory/hero-inventory-modal.tsx?raw';
import resourcesCopy from '@/sync-steel/panels/copies/hero-resources-modal.tsx?raw';
import resourcesUpstream from '@/components/modals/hero-resources/hero-resources-modal.tsx?raw';
import vitalsCopy from '@/sync-steel/panels/copies/hero-vitals-modal.tsx?raw';
import vitalsUpstream from '@/components/modals/hero-vitals/hero-vitals-modal.tsx?raw';

// Sync Steel's live hero drawers (src/sync-steel/panels/)

const sources: Record<string, { upstream: string, copy: string }> = {
	'hero-resources': { upstream: resourcesUpstream, copy: resourcesCopy },
	'hero-vitals': { upstream: vitalsUpstream, copy: vitalsCopy },
	'hero-inventory': { upstream: inventoryUpstream, copy: inventoryCopy }
};

describe('the live copies of upstream\'s drawers', () => {
	it.each(LIVE_PANEL_COPIES.map(panel => [ panel.name, panel ] as const))('%s is upstream\'s current file with only the Sync Steel changes', (_name, panel) => {
		const { upstream, copy } = sources[panel.folder];

		// If this fails, upstream changed the drawer: run node scripts/sync-steel/update-live-panels.ts and review the diff
		expect(copy).toBe(liveCopy(panel, upstream));
	});

	it('marks exactly its changes', () => {
		const copy = liveCopy(LIVE_PANEL_COPIES[0], resourcesUpstream);

		expect(copy.match(/\/\/ Sync Steel: /g)).toHaveLength(4);
		expect(copy).not.toContain('remoteChanges');
		expect(copy).toContain('export const LiveHeroResourcesModal = (props: Props) => {');
		expect(copy).toContain('useRemoteHero(props.hero.id, remote => setHero(Utils.copy(remote)));');
		expect(copy).not.toContain('import \'./hero-resources-modal.scss\';');
	});

	it('remounts Vitals\' health panel on a remote change, since it keeps its own copy', () => {
		const copy = liveCopy(LIVE_PANEL_COPIES[1], vitalsUpstream);

		expect(copy).toContain('setRemoteChanges(count => count + 1);');
		expect(copy).toMatch(/<HeroHealthPanel\n\s+key=\{remoteChanges\}\n/);
	});

	it('remounts Inventory\'s items and notes only when a remote change touched the inventory', () => {
		const copy = liveCopy(LIVE_PANEL_COPIES[2], inventoryUpstream);

		expect(copy).toContain('const touched = ([ \'inventory\', \'inventoryText\' ] as const).some(');
		expect(copy).toContain('<Space key={remoteChanges} orientation=\'vertical\' style={{ width: \'100%\', paddingBottom: \'20px\' }}>');
	});

	it('fails loudly when upstream\'s file no longer has what it changes', () => {
		expect(() => liveCopy(LIVE_PANEL_COPIES[1], vitalsUpstream.replace('useState<Hero>', 'useState<Hero | null>'))).toThrow(/expected exactly one/);
	});
});

describe('the branded build\'s redirect', () => {
	const root = '/repo';

	it('sends every importer of an upstream drawer to its switcher', () => {
		expect(redirectFor(root, '/repo/src/components/modals/hero-vitals/hero-vitals-modal.tsx', '/repo/src/hooks/use-modals.tsx'))
			.toBe('/repo/src/sync-steel/panels/hero-vitals-modal.tsx');
		expect(redirectFor(root, '/repo/src/components/modals/hero-vitals/hero-vitals-modal.tsx', '/repo/src/components/panels/run/encounter-run/encounter-run-panel.tsx'))
			.toBe('/repo/src/sync-steel/panels/hero-vitals-modal.tsx');
	});

	it('lets the switcher import the original', () => {
		expect(redirectFor(root, '/repo/src/components/modals/hero-vitals/hero-vitals-modal.tsx', '/repo/src/sync-steel/panels/hero-vitals-modal.tsx')).toBeNull();
	});

	it('leaves everything else alone, including the drawers\' stylesheets', () => {
		expect(redirectFor(root, '/repo/src/components/modals/hero-level-up/hero-level-up-modal.tsx', '/repo/src/hooks/use-modals.tsx')).toBeNull();
		expect(redirectFor(root, '/repo/src/components/modals/hero-vitals/hero-vitals-modal.scss', '/repo/src/sync-steel/panels/copies/hero-vitals-modal.tsx')).toBeNull();
	});

	it('copes with queries, backslashes and a trailing slash on the root', () => {
		expect(redirectFor('C:\\repo\\', 'C:\\repo\\src\\components\\modals\\hero-resources\\hero-resources-modal.tsx?v=1', 'C:\\repo\\src\\hooks\\use-modals.tsx'))
			.toBe('C:/repo/src/sync-steel/panels/hero-resources-modal.tsx');
	});

	it('covers the three drawers, each with a switcher', () => {
		expect(LIVE_PANELS.map(p => p.switcher)).toEqual([
			'src/sync-steel/panels/hero-resources-modal.tsx',
			'src/sync-steel/panels/hero-vitals-modal.tsx',
			'src/sync-steel/panels/hero-inventory-modal.tsx'
		]);
		expect(livePanelFiles()).toHaveLength(6);
	});
});

describe('the Live panels switch', () => {
	beforeEach(() => {
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is on until turned off, and remembers', () => {
		expect(LivePanels.isOn()).toBe(true);
		LivePanels.set(false);
		expect(LivePanels.isOn()).toBe(false);
		LivePanels.set(true);
		expect(LivePanels.isOn()).toBe(true);
	});

	it('is on where there\'s no storage', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(LivePanels.isOn()).toBe(true);
	});
});

describe('RemoteHeroes', () => {
	const hero = (id: string, rev: number) => ({ id: id, _syncSteel: { rev: rev } }) as unknown as StampedHero;

	it('tells each listener about its own hero only, until it unsubscribes', () => {
		const seen: number[] = [];
		const other: number[] = [];
		const stop = RemoteHeroes.subscribe('a', h => seen.push(h._syncSteel?.rev ?? 0));
		const stopOther = RemoteHeroes.subscribe('b', h => other.push(h._syncSteel?.rev ?? 0));

		RemoteHeroes.publish(hero('a', 2));
		RemoteHeroes.publish(hero('b', 5));
		stop();
		RemoteHeroes.publish(hero('a', 3));
		stopOther();

		expect(seen).toEqual([ 2 ]);
		expect(other).toEqual([ 5 ]);
		expect(RemoteHeroes.listenerCount('a')).toBe(0);
	});

	it('keeps telling other listeners when one throws', () => {
		const seen: string[] = [];
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const stopBad = RemoteHeroes.subscribe('a', () => {
			throw new Error('broken panel');
		});
		const stopGood = RemoteHeroes.subscribe('a', h => seen.push(h.id));

		RemoteHeroes.publish(hero('a', 4));
		stopBad();
		stopGood();

		expect(seen).toEqual([ 'a' ]);
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
