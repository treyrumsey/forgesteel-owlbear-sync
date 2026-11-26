import { type HeroSummary, readSummary } from './summary.ts';
import type { Connection } from './connection.ts';

// The extension's connection to the api's live hub (server/src/hub.ts), signed in with the room's Owlbear token.
// It keeps every hero's latest summary, reconnects with backoff, and catches up by revision. It mirrors the
// fork's SyncSteelSocket (src/sync-steel/live/sync-steel-socket.ts), which can't be shared: that one imports
// the fork's models.

export type HubStatus = 'off' | 'connecting' | 'live' | 'offline';

export interface SocketLike {
	readonly readyState: number;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number, reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface HubClientOptions {
	connection: Connection;
	onSummary: (summary: HeroSummary) => void;
	onDeleted: (heroId: string) => void;
	// After each (re)connect's catch-up, once the summaries are complete
	onSynced: () => void;
	onStatus: (status: HubStatus, detail?: string) => void;
	createSocket?: (url: string) => SocketLike;
	random?: () => number;
}

const OPEN = 1;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
export const PONG_TIMEOUT_MS = 5000;
// 4001: the token was replaced or disconnected. 4003: the api can't compute summaries. Retrying won't help.
const FINAL_CLOSE_CODES = [ 4001, 4003 ];

export const liveUrl = (api: string) => `${api.trim().replace(/\/+$/, '').replace(/^http/i, 'ws')}/live`;

export class HubClient {
	private readonly options: HubClientOptions;
	private readonly summaries = new Map<string, HeroSummary>();
	private socket: SocketLike | null = null;
	private welcomed = false;
	private stopped = true;
	private attempts = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private pongTimer: ReturnType<typeof setTimeout> | null = null;
	roomName = '';

	constructor(options: HubClientOptions) {
		this.options = options;
	}

	get(heroId: string) {
		return this.summaries.get(heroId) ?? null;
	}

	all() {
		return [ ...this.summaries.values() ];
	}

	start() {
		if (!this.stopped) {
			return;
		}
		this.stopped = false;
		this.connect();
	}

	stop() {
		this.stopped = true;
		this.clearTimers();
		this.drop();
		this.options.onStatus('off');
	}

	// Reconnect now if the socket is gone, or ping it and reconnect if the hub doesn't answer
	check() {
		if (this.stopped) {
			return;
		}
		if (!this.socket || (this.socket.readyState !== OPEN) || !this.welcomed) {
			if (this.retryTimer) {
				clearTimeout(this.retryTimer);
				this.retryTimer = null;
				this.connect();
			}
			return;
		}
		if (this.pongTimer) {
			return;
		}
		this.socket.send(JSON.stringify({ type: 'ping' }));
		this.pongTimer = setTimeout(() => {
			this.pongTimer = null;
			this.drop();
			this.connect();
		}, PONG_TIMEOUT_MS);
	}

	private connect() {
		this.options.onStatus('connecting');
		const create = this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
		let socket: SocketLike;
		try {
			socket = create(liveUrl(this.options.connection.api));
		} catch (error) {
			this.scheduleRetry(String(error));
			return;
		}
		this.socket = socket;
		this.welcomed = false;

		socket.onopen = () => {
			const known = Object.fromEntries([ ...this.summaries.values() ].map(summary => [ summary.heroId, summary.rev ]));
			socket.send(JSON.stringify({ type: 'hello', token: this.options.connection.token, heroes: known }));
		};
		socket.onmessage = event => {
			if (this.socket === socket) {
				this.receive(event.data);
			}
		};
		socket.onclose = event => {
			if (this.socket !== socket) {
				return;
			}
			this.socket = null;
			this.welcomed = false;
			if (FINAL_CLOSE_CODES.includes(event.code)) {
				this.stopped = true;
				this.clearTimers();
				this.options.onStatus('offline', event.reason || `Closed (${event.code})`);
				return;
			}
			this.scheduleRetry(event.reason);
		};
		socket.onerror = () => undefined;
	}

	private receive(data: unknown) {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(String(data)) as Record<string, unknown>;
		} catch {
			return;
		}
		switch (message.type) {
			case 'welcome': {
				this.welcomed = true;
				this.attempts = 0;
				const room = message.room as { name?: unknown } | undefined;
				this.roomName = typeof room?.name === 'string' ? room.name : '';
				this.options.onStatus('live');
				break;
			}
			case 'summary': {
				const summary = readSummary(message.summary);
				if (summary) {
					this.summaries.set(summary.heroId, summary);
					this.options.onSummary(summary);
				}
				break;
			}
			case 'hero.deleted':
				if (typeof message.heroId === 'string') {
					this.summaries.delete(message.heroId);
					this.options.onDeleted(message.heroId);
				}
				break;
			case 'synced':
				this.options.onSynced();
				break;
			case 'pong':
				if (this.pongTimer) {
					clearTimeout(this.pongTimer);
					this.pongTimer = null;
				}
				break;
		}
	}

	private scheduleRetry(detail?: string) {
		if (this.stopped) {
			return;
		}
		this.options.onStatus('offline', detail);
		const random = this.options.random ?? Math.random;
		const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * (2 ** this.attempts));
		this.attempts += 1;
		const delay = Math.round(base * (0.5 + (random() / 2)));
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect();
		}, delay);
	}

	private drop() {
		const socket = this.socket;
		this.socket = null;
		this.welcomed = false;
		if (socket) {
			socket.onclose = null;
			socket.onmessage = null;
			socket.close();
		}
	}

	private clearTimers() {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.pongTimer) {
			clearTimeout(this.pongTimer);
			this.pongTimer = null;
		}
	}
}

// One attempt, for the popover's Connect button: does this connection reach the hub and sign in?
export const testConnection = (connection: Connection, timeoutMs = 8000, createSocket?: (url: string) => SocketLike) => {
	return new Promise<{ ok: true, roomName: string } | { ok: false, reason: string }>(resolve => {
		let settled = false;
		const finish = (result: { ok: true, roomName: string } | { ok: false, reason: string }) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				socket?.close();
				resolve(result);
			}
		};
		const timer = setTimeout(() => finish({ ok: false, reason: 'The Sync Steel server didn\'t answer.' }), timeoutMs);
		let socket: SocketLike | null = null;
		try {
			socket = (createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike))(liveUrl(connection.api));
		} catch (error) {
			finish({ ok: false, reason: String(error) });
			return;
		}
		socket.onopen = () => socket?.send(JSON.stringify({ type: 'hello', token: connection.token, heroes: {} }));
		socket.onmessage = event => {
			try {
				const message = JSON.parse(String(event.data)) as { type?: string, kind?: string, room?: { name?: string } };
				if (message.type === 'welcome') {
					finish(message.kind === 'obr'
						? { ok: true, roomName: message.room?.name ?? '' }
						: { ok: false, reason: 'That\'s a device token, not an Owlbear connection. Copy the connection from GM tools → Owlbear.' });
				}
			} catch {
				// Ignore anything that isn't JSON
			}
		};
		socket.onclose = event => finish({ ok: false, reason: event.reason || `The server closed the connection (${event.code}).` });
		socket.onerror = () => undefined;
	});
};
