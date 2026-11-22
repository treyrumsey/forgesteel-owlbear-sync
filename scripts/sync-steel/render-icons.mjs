// Renders Sync Steel's icons from one SVG design into public/sync-steel/.
//
//   node scripts/sync-steel/render-icons.mjs
//
// Uses Playwright with the installed Google Chrome (channel 'chrome'), so no browser download is needed.
// The design is original: two sync arrows around a hex nut. It uses no Forge Steel or Draw Steel art.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const out = fileURLToPath(new URL('../../public/sync-steel/', import.meta.url));

// rounded: a rounded tile for favicons and "any" icons. Square: full-bleed, for maskable and Apple icons,
// which the platform masks itself. Everything sits inside the maskable safe zone (a centred circle, 80% wide).
const svg = rounded => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
	<defs>
		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#2f4858"/>
			<stop offset="1" stop-color="#16232e"/>
		</linearGradient>
		<linearGradient id="steel" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#f4f8fb"/>
			<stop offset="1" stop-color="#9db4c6"/>
		</linearGradient>
		<marker id="head" viewBox="0 0 10 10" refX="4" refY="5" markerWidth="2.6" markerHeight="2.6" orient="auto-start-reverse">
			<path d="M0 0 L10 5 L0 10 Z" fill="#7fd1c7"/>
		</marker>
	</defs>
	<rect width="512" height="512" rx="${rounded ? 112 : 0}" fill="url(#bg)"/>
	<g fill="none" stroke="#7fd1c7" stroke-width="30" stroke-linecap="round" marker-end="url(#head)">
		<path d="M131.1 177.2 A148 148 0 0 1 368.4 159.6"/>
		<path d="M380.9 334.8 A148 148 0 0 1 143.6 352.4"/>
	</g>
	<g stroke-linejoin="round">
		<path d="M336 256 L296 325.3 L216 325.3 L176 256 L216 186.7 L296 186.7 Z" fill="url(#steel)" stroke="#e8eff5" stroke-width="6"/>
		<circle cx="256" cy="256" r="36" fill="#1f3140" stroke="#6f889c" stroke-width="6"/>
	</g>
</svg>
`;

const icons = [
	{ file: 'icon.svg', size: null, rounded: true },
	{ file: 'favicon-64.png', size: 64, rounded: true },
	{ file: 'icon-192.png', size: 192, rounded: true },
	{ file: 'icon-512.png', size: 512, rounded: true },
	{ file: 'icon-maskable-512.png', size: 512, rounded: false },
	{ file: 'apple-touch-icon.png', size: 180, rounded: false }
];

const browser = await chromium.launch({ channel: 'chrome' });
try {
	for (const icon of icons) {
		if (!icon.size) {
			writeFileSync(join(out, icon.file), svg(icon.rounded));
			continue;
		}
		const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
		await page.setContent(`<html><body style="margin:0;background:transparent">${svg(icon.rounded).replace('<svg ', `<svg width="${icon.size}" height="${icon.size}" `)}</body></html>`);
		await page.screenshot({ path: join(out, icon.file), omitBackground: true, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
		await page.close();
	}
} finally {
	await browser.close();
}
console.log(`Rendered ${icons.length} icons into ${out}`);
