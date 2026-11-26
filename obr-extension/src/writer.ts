import type { HeroSummary } from './summary.ts';

// The elected writer's queue of token writes (report §4.8 stage 3). Plain TypeScript with an injected clock,
// so the pacing can be tested with fake timers; background.ts supplies the Owlbear write.
//
// - Per token: 300 ms trailing, at most 1.5 s after the first change; only the latest summary is written.
// - Quiet window: wait while someone else changed the token in the last 750 ms, but write anyway 3 s after
//   the first change (with a fresh read).
// - Scene settle: hold everything until the scene has been quiet for 1 s after it opens or items are added.
// - One Owlbear call in flight at a time, carrying every token that's due, and at most about 3 calls a second
//   (spike finding 5: Owlbear allows about 10 a second per client, shared with DST's own clicks).
// - On RateLimitHit, wait 1 s and retry with the latest values.

export interface WriterTiming {
	trailingMs: number;
	maxWaitMs: number;
	quietMs: number;
	quietMaxMs: number;
	settleMs: number;
	minIntervalMs: number;
	rateLimitBackoffMs: number;
}

export const DEFAULT_TIMING: WriterTiming = {
	trailingMs: 300,
	maxWaitMs: 1500,
	quietMs: 750,
	quietMaxMs: 3000,
	settleMs: 1000,
	minIntervalMs: 333,
	rateLimitBackoffMs: 1000
};

export interface TokenWrite {
	tokenId: string;
	summary: HeroSummary;
}

export type WriteOutcome =
	| { ok: true }
	| { ok: false, rateLimited: boolean, error?: unknown };

export interface WriterDeps {
	now: () => number;
	setTimer: (callback: () => void, ms: number) => unknown;
	clearTimer: (timer: unknown) => void;
	// Re-reads the tokens, writes what differs, and resolves once Owlbear has answered
	write: (batch: TokenWrite[]) => Promise<WriteOutcome>;
	log?: (line: string) => void;
}

interface Pending {
	summary: HeroSummary;
	firstAt: number;
	lastAt: number;
}

export class TokenWriter {
	private readonly deps: WriterDeps;
	private readonly timing: WriterTiming;
	private readonly pending = new Map<string, Pending>();
	private readonly touched = new Map<string, number>();
	private settleUntil = 0;
	private nextAllowedAt = 0;
	private inFlight = false;
	private timer: unknown = null;
	private stopped = false;

	constructor(deps: WriterDeps, timing: Partial<WriterTiming> = {}) {
		this.deps = deps;
		this.timing = { ...DEFAULT_TIMING, ...timing };
	}

	// The token should show this summary
	want(tokenId: string, summary: HeroSummary) {
		const now = this.deps.now();
		const existing = this.pending.get(tokenId);
		this.pending.set(tokenId, { summary: summary, firstAt: existing?.firstAt ?? now, lastAt: now });
		this.pump();
	}

	// Someone else (a person, DST or another extension) just changed the token
	touch(tokenId: string) {
		this.touched.set(tokenId, this.deps.now());
		if (this.pending.has(tokenId)) {
			this.pump();
		}
	}

	// The scene opened or items arrived: wait for it to settle before writing
	settle() {
		this.settleUntil = this.deps.now() + this.timing.settleMs;
		this.pump();
	}

	forget(tokenId: string) {
		this.pending.delete(tokenId);
		this.touched.delete(tokenId);
	}

	pendingCount() {
		return this.pending.size;
	}

	stop() {
		this.stopped = true;
		this.pending.clear();
		this.touched.clear();
		if (this.timer !== null) {
			this.deps.clearTimer(this.timer);
			this.timer = null;
		}
	}

	// When this token's write is due, ignoring the settle and rate budget
	private dueAt(tokenId: string, entry: Pending) {
		let due = Math.min(entry.lastAt + this.timing.trailingMs, entry.firstAt + this.timing.maxWaitMs);
		const touchedAt = this.touched.get(tokenId);
		if (touchedAt !== undefined) {
			const quietEnds = Math.min(touchedAt + this.timing.quietMs, entry.firstAt + this.timing.quietMaxMs);
			due = Math.max(due, quietEnds);
		}
		return due;
	}

	private pump() {
		if (this.stopped || this.inFlight) {
			return;
		}
		if (this.timer !== null) {
			this.deps.clearTimer(this.timer);
			this.timer = null;
		}
		if (this.pending.size === 0) {
			return;
		}

		const now = this.deps.now();
		const gate = Math.max(this.settleUntil, this.nextAllowedAt);
		const due: TokenWrite[] = [];
		let next = Number.POSITIVE_INFINITY;
		this.pending.forEach((entry, tokenId) => {
			const at = Math.max(this.dueAt(tokenId, entry), gate);
			if (at <= now) {
				due.push({ tokenId: tokenId, summary: entry.summary });
			} else {
				next = Math.min(next, at);
			}
		});

		if (due.length === 0) {
			this.timer = this.deps.setTimer(() => {
				this.timer = null;
				this.pump();
			}, next - now);
			return;
		}

		due.forEach(write => this.pending.delete(write.tokenId));
		this.inFlight = true;
		this.nextAllowedAt = now + this.timing.minIntervalMs;
		this.deps.write(due)
			.catch((error: unknown): WriteOutcome => ({ ok: false, rateLimited: false, error: error }))
			.then(outcome => {
				this.inFlight = false;
				if (this.stopped) {
					return;
				}
				if (!outcome.ok) {
					if (outcome.rateLimited) {
						this.nextAllowedAt = this.deps.now() + this.timing.rateLimitBackoffMs;
						this.deps.log?.(`Owlbear rate limit: retrying ${due.length} token(s) in ${this.timing.rateLimitBackoffMs} ms`);
					} else {
						this.deps.log?.(`Write failed: ${String(outcome.error)}`);
					}
					// Retry with the latest values: a newer want for the token wins
					const at = this.deps.now();
					due.filter(write => !this.pending.has(write.tokenId))
						.forEach(write => this.pending.set(write.tokenId, { summary: write.summary, firstAt: at, lastAt: at }));
				}
				this.pump();
			});
	}
}
