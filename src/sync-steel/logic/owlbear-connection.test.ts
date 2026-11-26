import { describe, expect, it } from 'vitest';
import { OwlbearConnectionLogic } from '@/sync-steel/logic/owlbear-connection';
import { parseConnection } from '../../../obr-extension/src/connection';

// The Sync Steel page writes the connection string and the Owlbear extension reads it
describe('the Owlbear connection string', () => {
	it('round-trips from the Sync Steel page to the extension', () => {
		const text = OwlbearConnectionLogic.encode({ api: 'https://api.example.test/', token: 'sst_abc-_123' });

		expect(parseConnection(`  ${text}\n`)).toEqual({ api: 'https://api.example.test', token: 'sst_abc-_123' });
	});

	it('rejects anything else', () => {
		expect(parseConnection('sst_abc')).toBeNull();
		expect(parseConnection('sync-steel-owlbear:not-base64!')).toBeNull();
		expect(parseConnection(`sync-steel-owlbear:${btoa(JSON.stringify({ api: 'ftp://x', token: 'sst_1' }))}`)).toBeNull();
	});

	it('gives the manifest URL on the app\'s own domain', () => {
		expect(OwlbearConnectionLogic.getManifestUrl('https://syncsteel.app')).toBe('https://syncsteel.app/owlbear/manifest.json');
	});
});
