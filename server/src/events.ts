import type { RevisionSource } from './store/heroes.ts';

// Raised after each commit. Phase 3's WebSocket hub listens to these to notify clients.
export type ServerEvent =
	| { type: 'hero.changed', roomId: string, heroId: string, seatId: string, rev: number, sid: string | null, source: RevisionSource }
	| { type: 'hero.deleted', roomId: string, heroId: string, seatId: string, rev: number };

export interface EventBus {
	emit: (event: ServerEvent) => void;
	on: (listener: (event: ServerEvent) => void) => () => void;
}

export const createEventBus = (): EventBus => {
	const listeners = new Set<(event: ServerEvent) => void>();

	return {
		emit: event => {
			listeners.forEach(listener => {
				// A failing listener mustn't fail the request whose change has already committed
				try {
					listener(event);
				} catch (error) {
					console.error('Event listener failed', error);
				}
			});
		},
		on: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
};
