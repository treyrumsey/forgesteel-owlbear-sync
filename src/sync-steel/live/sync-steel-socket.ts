import { Hero } from '@/models/hero';

// The live-sync connection to the Sync Steel api's hub (server/src/hub.ts). Plain TypeScript, no React,
// so it can be tested in Node. It keeps one WebSocket open, reconnects with backoff, and keeps the
// revision of each hero this device has, so a reconnect only fetches what changed.

export type LiveStatus = 'off' | 'connecting' | 'live' | 'offline';

export type StampedHero = Hero & { _syncSteel?: { rev?: number } };

// The parts of the browser's WebSocket used here
export interface SocketLike {
	readonly readyState: number;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number, reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface SyncSteelSocketOptions {
	host: string;
	deviceToken: string;
	onHero: (hero: StampedHero) => void;
	onDeleted: (heroId: string) => void;
	onStatus: (status: LiveStatus, detail?: string) => void;
	createSocket?: (url: string) => SocketLike;
	random?: () => number;
}

const OPEN = 1;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// How long a visibility check waits for a pong before it reconnects
export const PONG_TIMEOUT_MS = 5000;
// The hub closes with these when the device isn't (or is no longer) in the room: retrying won't help
const FINAL_CLOSE_CODES = [ 4001 ];

export const liveUrl = (host: string) => `${host.trim().replace(/\/+$/, '').replace(/^http/i, 'ws')}/live`;

export const stampRev = (hero: StampedHero) => {
	const rev = hero._syncSteel?.rev;
	return Number.isInteger(rev) ? rev as number : null;
};

export class SyncSteelSocket {
	private readonly options: SyncSteelSocketOptions;
	private readonly revs = new Map<string, number>();
	private socket: SocketLike | null = null;
	private welcomed = false;
	private stopped = true;
	private attempts = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private pongTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: SyncSteelSocketOptions) {
		this.options = options;
	}

	// The revisions this device already has, from the stamps on the heroes it loaded
	seed(heroes: StampedHero[]) {
		heroes.forEach(hero => {
			const rev = stampRev(hero);
			if ((rev !== null) && !this.revs.has(hero.id)) {
				this.revs.set(hero.id, rev);
			}
		});
	}

	knownRevs() {
		return Object.fromEntries(this.revs);
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

	// Called when the app comes back to the foreground or online: reconnect now if the socket is gone,
	// or ping it and reconnect if the hub doesn't answer (an iPad's socket can die without closing)
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
			socket = create(liveUrl(this.options.host));
		} catch (error) {
			this.scheduleRetry(String(error));
			return;
		}
		this.socket = socket;
		this.welcomed = false;

		socket.onopen = () => {
			socket.send(JSON.stringify({ type: 'hello', token: this.options.deviceToken, heroes: this.knownRevs() }));
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
				this.options.onStatus('offline', event.reason);
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
			case 'welcome':
				this.welcomed = true;
				this.attempts = 0;
				this.options.onStatus('live');
				break;
			case 'hero': {
				const hero = message.hero as StampedHero;
				const rev = stampRev(hero);
				if (rev !== null) {
					this.revs.set(hero.id, rev);
				}
				this.options.onHero(hero);
				break;
			}
			case 'hero.own':
				if ((typeof message.heroId === 'string') && Number.isInteger(message.rev)) {
					this.revs.set(message.heroId, message.rev as number);
				}
				break;
			case 'hero.deleted':
				if (typeof message.heroId === 'string') {
					this.revs.delete(message.heroId);
					this.options.onDeleted(message.heroId);
				}
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
		const ceiling = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * (2 ** this.attempts));
		const delay = Math.max(MIN_BACKOFF_MS, Math.round(ceiling * (0.5 + (random() / 2))));
		this.attempts += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect();
		}, delay);
	}

	private drop() {
		const socket = this.socket;
		this.socket = null;
		this.welcomed = false;
		if (this.pongTimer) {
			clearTimeout(this.pongTimer);
			this.pongTimer = null;
		}
		if (socket) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onclose = null;
			socket.close(1000, 'Reconnecting');
		}
	}

	private clearTimers() {
		[ this.retryTimer, this.pongTimer ].forEach(timer => {
			if (timer) {
				clearTimeout(timer);
			}
		});
		this.retryTimer = null;
		this.pongTimer = null;
	}
}
