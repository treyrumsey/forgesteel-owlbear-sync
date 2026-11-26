import { describe, expect, it } from 'vitest';
import { manifest } from '../vite.config.ts';

describe('the Owlbear manifest', () => {
	it('fits Owlbear\'s limits and points every page at where the extension is served', () => {
		const built = manifest('/owlbear/');

		// Owlbear refuses a description over 128 characters when the extension is added
		expect(built.description.length).toBeLessThanOrEqual(128);
		expect([ built.icon, built.background_url, built.action.popover, built.action.icon ].every(url => url.startsWith('/owlbear/'))).toBe(true);
	});
});
