import { describe, expect, it } from 'vitest';
import { generateJoinCode, hashSecret, normalizeJoinCode } from './secrets.ts';
import { createRateLimiter } from './rate-limit.ts';

describe('join codes', () => {
	it('are 10 Crockford base32 characters, grouped for reading aloud', () => {
		const codes = Array.from({ length: 50 }, generateJoinCode);

		expect(codes.every(code => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(code))).toBe(true);
		expect(new Set(codes).size).toBe(50);
	});

	it('normalise case, spaces, dashes and the letters people type for 0 and 1', () => {
		expect(normalizeJoinCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
		expect(normalizeJoinCode('oOiIl-LLLLL')).toBe('0011111111');
		expect(normalizeJoinCode('ABCDE')).toBeNull();
		expect(normalizeJoinCode('ABCDE-FGHJU')).toBeNull();
	});
});

describe('hashSecret', () => {
	it('depends on the key and the kind of secret', () => {
		const hash = hashSecret('key', 'device', 'value');

		expect(hashSecret('key', 'device', 'value')).toBe(hash);
		expect(hashSecret('other-key', 'device', 'value')).not.toBe(hash);
		expect(hashSecret('key', 'gm-key', 'value')).not.toBe(hash);
	});
});

describe('createRateLimiter', () => {
	it('allows the limit per window, then reports the wait until the window ends', () => {
		const clock = { now: 0 };
		const limiter = createRateLimiter(() => clock.now);
		const rule = { limit: 2, windowSeconds: 60 };

		const results = [ limiter.consume('ip', rule), limiter.consume('ip', rule), limiter.consume('ip', rule), limiter.consume('other', rule) ];
		clock.now = 45 * 1000;
		const waiting = limiter.consume('ip', rule);
		clock.now = 60 * 1000;
		const reset = limiter.consume('ip', rule);

		expect(results).toEqual([ null, null, 60, null ]);
		expect(waiting).toBe(15);
		expect(reset).toBeNull();
	});
});
