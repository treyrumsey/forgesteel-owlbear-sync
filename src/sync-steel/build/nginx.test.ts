import { describe, expect, it } from 'vitest';
import ours from '../../../nginx/sync-steel.conf?raw';
import upstream from '../../../nginx/default.conf?raw';

// fs-web serves with nginx/sync-steel.conf (Dockerfile.sync-steel) instead of upstream's nginx/default.conf.
// It must be upstream's file plus our marked blocks, so an upstream change to its config fails here.

const withoutOurBlocks = (conf: string) => conf.replace(/^[ \t]*# sync-steel:begin\n[\s\S]*?^[ \t]*# sync-steel:end\n\n/gm, '');

describe('nginx/sync-steel.conf', () => {
	it('is upstream\'s nginx config plus the Sync Steel blocks', () => {
		expect(withoutOurBlocks(ours)).toBe(upstream);
	});

	it('serves the Owlbear extension with CORS for Owlbear only, and no app fallback', () => {
		const block = /location \/owlbear\/ \{[\s\S]*?\n {2}\}/.exec(ours)?.[0] ?? '';
		expect(block).toContain('try_files $uri =404;');
		expect(block).toContain('add_header Access-Control-Allow-Origin $sync_steel_owlbear_origin;');
		expect(ours).toContain('~^https://([a-z0-9-]+\\.)*owlbear\\.rodeo$ $http_origin;');
	});
});
