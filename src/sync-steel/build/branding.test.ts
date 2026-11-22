import { SYNC_STEEL_BRAND, brandIndexHtml, brandManifest } from '@/sync-steel/build/branding';
import { describe, expect, it } from 'vitest';
import indexHtml from '../../../index.html?raw';

// Runs the branding against upstream's real index.html, so an upstream change that breaks it fails here

describe('brandIndexHtml', () => {
	const branded = brandIndexHtml(indexHtml);

	it('renames the app and swaps the icons', () => {
		expect(branded).toContain('<title>Sync Steel</title>');
		expect(branded).toContain('<meta name="apple-mobile-web-app-title" content="Sync Steel" />');
		expect(branded).toContain('href="/sync-steel/apple-touch-icon.png"');
		expect(branded).toContain('href="/sync-steel/favicon-64.png"');
		expect(branded).toContain(`<meta property="og:url" content="${SYNC_STEEL_BRAND.url}" />`);
		expect(branded).toContain(`<meta name="theme-color" content="${SYNC_STEEL_BRAND.themeColor}" />`);
		expect(branded).not.toContain('forgesteel.net');
	});

	it('removes upstream\'s Google Analytics and keeps the app', () => {
		expect(branded).not.toMatch(/googletagmanager|gtag/);
		expect(branded).toContain('<div id="root"></div>');
		expect(branded).toContain('src="/src/index.tsx"');
	});

	it('fails loudly when upstream\'s markup changes', () => {
		expect(() => brandIndexHtml(indexHtml.replace(/<title>[^<]*<\/title>/, ''))).toThrow(/<title>/);
		expect(() => brandIndexHtml(indexHtml.replace('<!-- Google tag (gtag.js) -->', ''))).toThrow(/Google tag/);
	});
});

describe('brandManifest', () => {
	it('replaces the name, colours and icons, and drops upstream\'s screenshots', () => {
		const manifest = JSON.parse(brandManifest(JSON.stringify({
			name: 'Forge Steel',
			short_name: 'Forge Steel',
			start_url: '/',
			theme_color: '#1890ff',
			icons: [ { src: '/shield.png' } ],
			screenshots: [ { src: '/pwa/wide.png' } ]
		})));
		expect(manifest).toEqual({
			name: 'Sync Steel',
			short_name: 'Sync Steel',
			description: SYNC_STEEL_BRAND.description,
			start_url: '/',
			theme_color: SYNC_STEEL_BRAND.themeColor,
			icons: SYNC_STEEL_BRAND.icons
		});
	});
});
