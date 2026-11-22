export interface RateRule {
	limit: number;
	windowSeconds: number;
}

export interface RateLimiter {
	// Counts an attempt. Returns the seconds to wait if the limit is already used up, otherwise null.
	consume: (key: string, rule: RateRule) => number | null;
	// Like consume, but doesn't count: for limits on failures, which are recorded afterwards
	blocked: (key: string, rule: RateRule) => number | null;
	record: (key: string, rule: RateRule) => void;
}

interface Window {
	start: number;
	count: number;
}

const MAX_KEYS = 10_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

// Fixed windows in memory: fine for one process, and a restart only resets the counts
export const createRateLimiter = (now: () => number): RateLimiter => {
	const windows = new Map<string, Window>();

	const current = (key: string, rule: RateRule) => {
		const window = windows.get(key);
		if (!window || (now() - window.start >= rule.windowSeconds * 1000)) {
			return null;
		}
		return window;
	};

	const sweep = () => {
		if (windows.size < MAX_KEYS) {
			return;
		}
		const cutoff = now() - MAX_WINDOW_MS;
		windows.forEach((window, key) => {
			if (window.start < cutoff) {
				windows.delete(key);
			}
		});
	};

	const blocked = (key: string, rule: RateRule) => {
		const window = current(key, rule);
		if (!window || (window.count < rule.limit)) {
			return null;
		}
		return Math.max(1, Math.ceil((window.start + (rule.windowSeconds * 1000) - now()) / 1000));
	};

	const record = (key: string, rule: RateRule) => {
		let window = current(key, rule);
		if (!window) {
			sweep();
			window = { start: now(), count: 0 };
			windows.set(key, window);
		}
		window.count += 1;
	};

	return {
		blocked: blocked,
		record: record,
		consume: (key, rule) => {
			const wait = blocked(key, rule);
			if (wait === null) {
				record(key, rule);
			}
			return wait;
		}
	};
};
