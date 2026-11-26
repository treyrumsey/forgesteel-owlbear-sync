import { type TokenWrite, TokenWriter, type WriteOutcome } from './writer.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeroSummary } from './summary.ts';

const summary = (stamina: number, heroId = 'hero-1'): HeroSummary => ({
	heroId: heroId,
	rev: stamina,
	seatName: 'Alice',
	name: 'Kalla',
	staminaMax: 21,
	stamina: stamina,
	staminaTemp: 0,
	recoveriesMax: 10,
	recoveries: 10,
	surges: 0,
	resource: null,
	conditions: []
});

let calls: { at: number, batch: TokenWrite[] }[];
let outcomes: WriteOutcome[];
let start: number;

const createWriter = () => new TokenWriter({
	now: () => Date.now(),
	setTimer: (callback, ms) => setTimeout(callback, ms),
	clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
	write: async batch => {
		calls.push({ at: Date.now() - start, batch: batch });
		return outcomes.shift() ?? { ok: true };
	}
});

const staminaWritten = () => calls.map(call => call.batch.map(write => `${write.tokenId}:${write.summary.stamina}`));

beforeEach(() => {
	vi.useFakeTimers();
	start = Date.now();
	calls = [];
	outcomes = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe('TokenWriter', () => {
	it('writes 300 ms after the last change, with only the latest values', async () => {
		const writer = createWriter();

		writer.want('t1', summary(20));
		await vi.advanceTimersByTimeAsync(200);
		writer.want('t1', summary(19));
		await vi.advanceTimersByTimeAsync(299);
		expect(calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		expect(staminaWritten()).toEqual([ [ 't1:19' ] ]);
		expect(calls[0].at).toBe(500);
	});

	it('writes within 1.5 s of the first change, however long the changes keep coming', async () => {
		const writer = createWriter();

		for (let i = 0; i < 10; i++) {
			writer.want('t1', summary(20 - i));
			await vi.advanceTimersByTimeAsync(200);
		}

		expect(calls[0].at).toBe(1500);
	});

	it('waits while someone else is editing the token, but no more than 3 s', async () => {
		const writer = createWriter();

		writer.want('t1', summary(20));
		writer.touch('t1');
		await vi.advanceTimersByTimeAsync(749);
		expect(calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls.map(call => call.at)).toEqual([ 750 ]);

		writer.want('t2', summary(18, 'hero-2'));
		for (let i = 0; i < 8; i++) {
			writer.touch('t2');
			await vi.advanceTimersByTimeAsync(500);
		}
		expect(calls.map(call => call.at)).toEqual([ 750, 750 + 3000 ]);
	});

	it('batches the tokens that are due into one call, and keeps to about 3 calls a second', async () => {
		const writer = createWriter();

		writer.want('t1', summary(20));
		writer.want('t2', summary(18, 'hero-2'));
		await vi.advanceTimersByTimeAsync(300);
		writer.want('t1', summary(19));
		writer.want('t1', summary(17));
		await vi.advanceTimersByTimeAsync(300);
		writer.want('t3', summary(15, 'hero-3'));
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(1000);

		expect(staminaWritten()).toEqual([ [ 't1:20', 't2:18' ], [ 't1:17' ], [ 't3:15' ] ]);
		const gaps = calls.slice(1).map((call, i) => call.at - calls[i].at);
		gaps.forEach(gap => expect(gap).toBeGreaterThanOrEqual(300));
	});

	it('holds writes until the scene settles', async () => {
		const writer = createWriter();

		writer.settle();
		writer.want('t1', summary(20));
		await vi.advanceTimersByTimeAsync(999);
		expect(calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		expect(calls.map(call => call.at)).toEqual([ 1000 ]);
	});

	it('backs off a second after a rate limit and retries with the latest values', async () => {
		const writer = createWriter();
		outcomes = [ { ok: false, rateLimited: true } ];

		writer.want('t1', summary(20));
		await vi.advanceTimersByTimeAsync(300);
		writer.want('t1', summary(19));
		await vi.advanceTimersByTimeAsync(2000);

		expect(staminaWritten()).toEqual([ [ 't1:20' ], [ 't1:19' ] ]);
		expect(calls[1].at).toBeGreaterThanOrEqual(1300);
	});

	it('has at most one call in flight', async () => {
		let release: (outcome: WriteOutcome) => void = () => undefined;
		const writer = new TokenWriter({
			now: () => Date.now(),
			setTimer: (callback, ms) => setTimeout(callback, ms),
			clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
			write: batch => {
				calls.push({ at: Date.now() - start, batch: batch });
				return new Promise(resolve => release = resolve);
			}
		});

		writer.want('t1', summary(20));
		await vi.advanceTimersByTimeAsync(300);
		writer.want('t2', summary(18, 'hero-2'));
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls).toHaveLength(1);
		release({ ok: true });
		await vi.advanceTimersByTimeAsync(0);

		expect(staminaWritten()).toEqual([ [ 't1:20' ], [ 't2:18' ] ]);
	});

	it('drops a forgotten token, and does nothing once stopped', async () => {
		const writer = createWriter();

		writer.want('t1', summary(20));
		writer.forget('t1');
		writer.want('t2', summary(18, 'hero-2'));
		writer.stop();
		await vi.advanceTimersByTimeAsync(2000);

		expect(calls).toEqual([]);
	});
});
