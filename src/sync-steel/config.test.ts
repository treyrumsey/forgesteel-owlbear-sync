import { SYNC_STEEL_DEV_API_HOST, resolveApiHost } from '@/sync-steel/config';
import { describe, expect, it } from 'vitest';

describe('resolveApiHost', () => {
	it('uses the configured host, without a trailing slash', () => {
		expect(resolveApiHost('https://api.example.com/')).toBe('https://api.example.com');
		expect(resolveApiHost(' https://api.example.com ')).toBe('https://api.example.com');
	});

	it('falls back to the local server when unset or never replaced', () => {
		expect(resolveApiHost(undefined)).toBe(SYNC_STEEL_DEV_API_HOST);
		expect(resolveApiHost('')).toBe(SYNC_STEEL_DEV_API_HOST);
		expect(resolveApiHost('FORGESTEEL_SYNC_STEEL_API_HOST')).toBe(SYNC_STEEL_DEV_API_HOST);
	});
});
