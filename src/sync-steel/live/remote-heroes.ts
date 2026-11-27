import { useEffect, useRef } from 'react';
import type { StampedHero } from '@/sync-steel/live/sync-steel-socket';

// Heroes that live sync has just applied because another device (or Owlbear) changed them. Sync Steel's live
// panels (src/sync-steel/panels/) listen here, so an open drawer can take the change without also reacting
// to this device's own saves, which reach the hero list too.

type Listener = (hero: StampedHero) => void;

const listeners = new Map<string, Set<Listener>>();

export const RemoteHeroes = {
	// Called by SyncSteelProvider for each hero it applies from the hub
	publish: (hero: StampedHero) => {
		listeners.get(hero.id)?.forEach(listener => {
			try {
				listener(hero);
			} catch (error) {
				console.error('Sync Steel: a live panel failed to take a remote change', error);
			}
		});
	},

	subscribe: (heroId: string, listener: Listener) => {
		const set = listeners.get(heroId) ?? new Set<Listener>();
		set.add(listener);
		listeners.set(heroId, set);
		return () => {
			set.delete(listener);
			if (set.size === 0) {
				listeners.delete(heroId);
			}
		};
	},

	listenerCount: (heroId: string) => listeners.get(heroId)?.size ?? 0
};

// Calls onRemote with each remote change to this hero while the component is mounted
export const useRemoteHero = (heroId: string, onRemote: Listener) => {
	const latest = useRef(onRemote);
	useEffect(() => {
		latest.current = onRemote;
	});
	useEffect(() => RemoteHeroes.subscribe(heroId, hero => latest.current(hero)), [ heroId ]);
};
