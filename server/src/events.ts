import type { RevisionSource } from './store/heroes.ts';

// Raised after each commit. The WebSocket hub (hub.ts) listens to these to notify clients.
export type ServerEvent =
	// deviceId is the writing device (null for an import or restore, which every device must fetch); merged says the stored hero differs from what it sent
	| { type: 'hero.changed', roomId: string, heroId: string, seatId: string, rev: number, sid: string | null, deviceId: string | null, merged: boolean, source: RevisionSource }
	| { type: 'hero.deleted', roomId: string, heroId: string, seatId: string, rev: number }
	| { type: 'device.revoked', roomId: string, deviceId: string };

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
