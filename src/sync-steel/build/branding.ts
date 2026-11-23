// Sync Steel's branding, applied at build time by vite.sync-steel.config.ts so upstream's
// index.html, vite.config.ts and public/ stay untouched.
//
// Every rewrite must match: if upstream changes index.html so one no longer does, the build
// (and branding.test.ts) fails instead of quietly shipping Forge Steel's branding or analytics.

export const SYNC_STEEL_BRAND = {
	name: 'Sync Steel',
	description: 'Your Draw Steel heroes, synced across your group\'s devices. An unofficial fork of Forge Steel.',
	url: 'https://syncsteel.app/',
	themeColor: '#2f4858',
	icons: [
		{ src: '/sync-steel/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
		{ src: '/sync-steel/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
		{ src: '/sync-steel/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
	]
};

// Sync Steel's stand-in for the Google tag: the same global, sending nothing
export const GTAG_STUB = '<script>function gtag() {}</script>';

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const replaceOnce = (html: string, pattern: RegExp, replacement: string, what: string) => {
	if (!pattern.test(html)) {
		throw new Error(`Sync Steel branding: upstream's index.html no longer has ${what}`);
	}
	return html.replace(pattern, replacement);
};

const setMeta = (html: string, attr: 'name' | 'property', key: string, value: string) => {
	const pattern = new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, '\\$&')}" content="[^"]*"\\s*/?>`);
	return replaceOnce(html, pattern, `<meta ${attr}="${key}" content="${escapeAttr(value)}" />`, `the ${key} meta tag`);
};

export const brandIndexHtml = (html: string) => {
	const brand = SYNC_STEEL_BRAND;
	let out = html;
	out = replaceOnce(out, /<link rel="icon"[^>]*>/, '<link rel="icon" type="image/png" href="/sync-steel/favicon-64.png" />', 'the favicon link');
	out = replaceOnce(out, /<link rel="apple-touch-icon"[^>]*>/, '<link rel="apple-touch-icon" sizes="180x180" href="/sync-steel/apple-touch-icon.png" />', 'the apple-touch-icon link');
	out = setMeta(out, 'name', 'description', brand.description);
	out = setMeta(out, 'property', 'og:description', brand.description);
	out = setMeta(out, 'property', 'og:title', brand.name);
	out = setMeta(out, 'property', 'og:site_name', brand.name);
	out = setMeta(out, 'property', 'og:image', `${brand.url}sync-steel/icon-512.png`);
	out = setMeta(out, 'property', 'og:image:width', '512');
	out = setMeta(out, 'property', 'og:image:height', '512');
	out = setMeta(out, 'property', 'og:image:alt', brand.name);
	out = setMeta(out, 'property', 'og:url', brand.url);
	out = setMeta(out, 'name', 'twitter:card', 'summary');
	out = setMeta(out, 'name', 'theme-color', brand.themeColor);
	out = setMeta(out, 'name', 'apple-mobile-web-app-title', brand.name);
	out = replaceOnce(out, /<title>[^<]*<\/title>/, `<title>${brand.name}</title>`, 'a <title>');

	// Upstream's Google Analytics would report this group's use to upstream's account. Its code
	// (src/utils/analytics.ts) still calls the global gtag() when heroes and homebrew are saved,
	// so a no-op takes the tag's place: without it those saves throw "gtag is not defined".
	out = replaceOnce(out, /<!-- Google tag \(gtag\.js\) -->\s*<script async src="https:\/\/www\.googletagmanager\.com\/[^"]*"><\/script>\s*<script>[\s\S]*?<\/script>/, GTAG_STUB, 'the Google tag');
	if (/googletagmanager|dataLayer|gtag\('config'/.test(out)) {
		throw new Error('Sync Steel branding: index.html still loads Google Analytics');
	}
	if (/content="Forge Steel[^"]*"|<title>Forge Steel/.test(out)) {
		throw new Error('Sync Steel branding: index.html still names the app Forge Steel');
	}
	return out;
};

export const brandManifest = (json: string) => {
	const brand = SYNC_STEEL_BRAND;
	const manifest = JSON.parse(json) as Record<string, unknown>;
	if (typeof manifest.name !== 'string' || !Array.isArray(manifest.icons)) {
		throw new Error('Sync Steel branding: the web manifest has an unexpected shape');
	}
	manifest.name = brand.name;
	manifest.short_name = brand.name;
	manifest.description = brand.description;
	manifest.theme_color = brand.themeColor;
	manifest.icons = brand.icons;
	// Upstream's install screenshots show Forge Steel
	delete manifest.screenshots;
	return JSON.stringify(manifest);
};
