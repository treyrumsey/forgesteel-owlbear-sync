import { type LiveStatus, type StampedHero, SyncSteelSocket, stampRev } from '@/sync-steel/live/sync-steel-socket';
import { PropsWithChildren, createContext, useContext, useEffect, useRef, useState } from 'react';
import { useDataManager, useHeroes } from '@/contexts/data-context';
import { ConnectionSettings } from '@/models/connection-settings';
import { SyncSteelConnection } from '@/sync-steel/logic/sync-steel-connection';
import { getSyncSteelApiHost } from '@/sync-steel/config';
import { sameHeroContent } from '@/sync-steel/live/sync-steel-heroes';

// Live sync (report §4.6). Mounted in src/index.tsx inside DataManagerProvider, the one upstream hook
// for it. While this browser is connected to a Sync Steel room, heroes other devices save arrive over the
// hub's WebSocket and are applied through Forge Steel's own dataManager.saveHero(), so every page that
// reads useHeroes() re-renders. The save that follows is an echo, which the server treats as a no-op.

export const SyncSteelStatusContext = createContext<LiveStatus>('off');

export const useSyncSteelStatus = () => useContext(SyncSteelStatusContext);

interface Props {
	connectionSettings: ConnectionSettings;
}

export const SyncSteelProvider = (props: PropsWithChildren<Props>) => {
	const dataManager = useDataManager();
	const heroes = useHeroes();
	const [ status, setStatus ] = useState<LiveStatus>('off');

	// DataManagerProvider makes a new DataManager each render, so the socket's callbacks read the latest
	const dataManagerRef = useRef(dataManager);
	const heroesRef = useRef(heroes);
	useEffect(() => {
		dataManagerRef.current = dataManager;
		heroesRef.current = heroes;
	});

	const host = getSyncSteelApiHost();
	const token = SyncSteelConnection.isConnected(props.connectionSettings, host) ? props.connectionSettings.warehouseToken : null;

	useEffect(() => {
		if (!token) {
			return;
		}

		// Heroes that arrive together are applied together (report §4.8 stage 5)
		const incoming = new Map<string, StampedHero | null>();
		let flushTimer: ReturnType<typeof setTimeout> | null = null;
		const flush = () => {
			flushTimer = null;
			const batch = [ ...incoming ];
			incoming.clear();
			batch.forEach(([ heroId, hero ]) => {
				const local = heroesRef.current.find(h => h.id === heroId) as StampedHero | undefined;
				if (hero === null) {
					if (local) {
						dataManagerRef.current.deleteHero(local).catch(err => console.error('Sync Steel: removing a deleted hero failed', err));
					}
					return;
				}
				if (local && (stampRev(local) === stampRev(hero)) && sameHeroContent(local, hero)) {
					return;
				}
				dataManagerRef.current.saveHero(hero).catch(err => console.error('Sync Steel: applying a hero failed', err));
			});
		};
		const queue = (heroId: string, hero: StampedHero | null) => {
			incoming.set(heroId, hero);
			flushTimer ??= setTimeout(flush, 0);
		};

		const socket = new SyncSteelSocket({
			host: host,
			deviceToken: token,
			onHero: hero => queue(hero.id, hero),
			onDeleted: heroId => queue(heroId, null),
			onStatus: setStatus
		});
		socket.seed(heroesRef.current as StampedHero[]);
		socket.start();

		// iPads suspend the socket in the background: check it whenever the app comes back
		const check = () => {
			if (document.visibilityState === 'visible') {
				socket.check();
			}
		};
		document.addEventListener('visibilitychange', check);
		window.addEventListener('online', check);
		window.addEventListener('pageshow', check);

		return () => {
			document.removeEventListener('visibilitychange', check);
			window.removeEventListener('online', check);
			window.removeEventListener('pageshow', check);
			if (flushTimer) {
				clearTimeout(flushTimer);
			}
			socket.stop();
		};
	}, [ host, token ]);

	return (
		<SyncSteelStatusContext value={token ? status : 'off'}>
			{props.children}
		</SyncSteelStatusContext>
	);
};
