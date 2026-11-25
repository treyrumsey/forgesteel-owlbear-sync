import { type LiveStatus, PONG_TIMEOUT_MS, type SocketLike, type StampedHero, SyncSteelSocket, liveUrl } from '@/sync-steel/live/sync-steel-socket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sameHeroContent } from '@/sync-steel/live/sync-steel-heroes';

class FakeSocket implements SocketLike {
	readyState = 0;
	sent: Record<string, unknown>[] = [];
	closedWith: number | null = null;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number, reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	send(data: string) {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close(code = 1000) {
		this.closedWith = code;
		this.readyState = 3;
	}

	open() {
		this.readyState = 1;
		this.onopen?.({});
	}

	receive(message: unknown) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	drop(code = 1006, reason = '') {
		this.readyState = 3;
		this.onclose?.({ code: code, reason: reason });
	}
}

const hero = (id: string, rev: number, name = 'Kalla') => ({ id: id, name: name, _syncSteel: { rev: rev } }) as unknown as StampedHero;

let sockets: FakeSocket[];
let statuses: LiveStatus[];
let heroes: StampedHero[];
let deleted: string[];

const create = () => new SyncSteelSocket({
	host: 'https://api.example/',
	deviceToken: 'device-token',
	onHero: h => heroes.push(h),
	onDeleted: id => deleted.push(id),
	onStatus: status => statuses.push(status),
	createSocket: url => {
		const socket = new FakeSocket(url);
		sockets.push(socket);
		return socket;
	},
	random: () => 1
});

const last = () => sockets[sockets.length - 1];

beforeEach(() => {
	vi.useFakeTimers();
	sockets = [];
	statuses = [];
	heroes = [];
	deleted = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe('SyncSteelSocket', () => {
	it('connects to the api\'s /live address and sends the device token and known revisions', () => {
		const socket = create();
		socket.seed([ hero('a', 3), { id: 'unstamped' } as StampedHero ]);
		socket.start();
		last().open();

		expect(last().url).toBe('wss://api.example/live');
		expect(last().sent).toEqual([ { type: 'hello', token: 'device-token', heroes: { a: 3 } } ]);
		expect(liveUrl('http://localhost:8787')).toBe('ws://localhost:8787/live');
	});

	it('reports live on welcome, and passes on heroes and deletions while tracking revisions', () => {
		const socket = create();
		socket.start();
		last().open();
		last().receive({ type: 'welcome' });
		last().receive({ type: 'hero', hero: hero('a', 4) });
		last().receive({ type: 'hero.own', heroId: 'b', rev: 7 });
		last().receive({ type: 'hero.deleted', heroId: 'c' });

		expect(statuses).toEqual([ 'connecting', 'live' ]);
		expect(heroes.map(h => h.id)).toEqual([ 'a' ]);
		expect(deleted).toEqual([ 'c' ]);
		expect(socket.knownRevs()).toEqual({ a: 4, b: 7 });
	});

	it('reconnects with growing backoff, and catches up with what it has seen', () => {
		const socket = create();
		socket.start();
		last().open();
		last().receive({ type: 'hero', hero: hero('a', 5) });
		last().drop();

		expect(statuses[statuses.length - 1]).toBe('offline');
		vi.advanceTimersByTime(999);
		expect(sockets).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(2);

		last().drop();
		vi.advanceTimersByTime(1999);
		expect(sockets).toHaveLength(2);
		vi.advanceTimersByTime(1);
		last().open();

		expect(last().sent[0]).toMatchObject({ type: 'hello', heroes: { a: 5 } });
	});

	it('stops retrying when the hub says the device isn\'t in the room', () => {
		const socket = create();
		socket.start();
		last().open();
		last().drop(4001, 'This device has been removed from the room.');
		vi.advanceTimersByTime(60_000);

		expect(sockets).toHaveLength(1);
		expect(statuses[statuses.length - 1]).toBe('offline');
		socket.check();
		expect(sockets).toHaveLength(1);
	});

	it('reconnects at once when the app comes back and the socket is gone', () => {
		const socket = create();
		socket.start();
		last().open();
		last().drop();

		socket.check();

		expect(sockets).toHaveLength(2);
	});

	it('pings when the app comes back, and reconnects if the hub doesn\'t answer', () => {
		const socket = create();
		socket.start();
		last().open();
		last().receive({ type: 'welcome' });

		socket.check();
		expect(last().sent[last().sent.length - 1]).toEqual({ type: 'ping' });
		last().receive({ type: 'pong' });
		vi.advanceTimersByTime(PONG_TIMEOUT_MS);
		expect(sockets).toHaveLength(1);

		socket.check();
		vi.advanceTimersByTime(PONG_TIMEOUT_MS);
		expect(sockets).toHaveLength(2);
		expect(sockets[0].closedWith).toBe(1000);
	});

	it('closes quietly when stopped, and ignores the old socket afterwards', () => {
		const socket = create();
		socket.start();
		last().open();
		const first = last();
		socket.stop();
		first.receive({ type: 'hero', hero: hero('a', 1) });
		vi.advanceTimersByTime(60_000);

		expect(statuses[statuses.length - 1]).toBe('off');
		expect(heroes).toEqual([]);
		expect(sockets).toHaveLength(1);
	});
});

describe('sameHeroContent', () => {
	it('ignores the stamp and key order', () => {
		const a = { id: 'a', name: 'Kalla', state: { surges: 1, notes: '' }, _syncSteel: { rev: 1 } } as unknown as StampedHero;
		const b = { name: 'Kalla', id: 'a', state: { notes: '', surges: 1 }, _syncSteel: { rev: 2 } } as unknown as StampedHero;

		expect(sameHeroContent(a, b)).toBe(true);
		expect(sameHeroContent(a, hero('a', 1, 'Vex'))).toBe(false);
	});
});
