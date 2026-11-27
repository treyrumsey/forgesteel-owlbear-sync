import { Plugin, UserConfig, defineConfig } from 'vite';
import { brandIndexHtml, brandManifest } from './src/sync-steel/build/branding';
import { livePanelFiles, redirectFor } from './src/sync-steel/build/live-panels';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import upstream from './vite.config';

// Sync Steel's production build: upstream's own vite.config.ts, plus Sync Steel's branding and api address.
//
//   npx vite build --config vite.sync-steel.config.ts
//
// Reusing upstream's config (rather than copying it) keeps its build, PWA and workbox settings
// in step with every upstream merge. `npm start` still uses upstream's config, unbranded, with upstream's
// hero drawers.

const syncSteelBranding = (): Plugin => ({
	name: 'sync-steel-branding',
	enforce: 'post',
	transformIndexHtml: {
		order: 'pre',
		handler: html => brandIndexHtml(html)
	},
	generateBundle: {
		order: 'post',
		handler(_, bundle) {
			// Emitted by vite-plugin-pwa from upstream's manifest options
			const manifest = bundle['manifest.json'];
			if (!manifest || manifest.type !== 'asset') {
				this.error('Sync Steel branding: the build emitted no manifest.json');
			}
			manifest.source = brandManifest(manifest.source.toString());
		}
	}
});

// Sync Steel's live hero drawers in place of upstream's (src/sync-steel/build/live-panels.ts)
const livePanels = (): Plugin => {
	const root = process.cwd();
	return {
		name: 'sync-steel-live-panels',
		enforce: 'pre',
		buildStart() {
			// If upstream moves or renames a drawer, fail rather than quietly ship the original
			livePanelFiles()
				.filter(path => !existsSync(resolve(root, path)))
				.forEach(path => this.error(`Sync Steel live panels: ${path} doesn't exist`));
		},
		async resolveId(source, importer, options) {
			if (!importer || !source.includes('-modal')) {
				return null;
			}
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			return resolved ? redirectFor(root, resolved.id, importer) : null;
		}
	};
};

const base = upstream as UserConfig;

export default defineConfig({
	...base,
	define: {
		...base.define,
		// nginx/env.sh replaces this placeholder with fs-web's variable of the same name when the container starts
		'import.meta.env.VITE_SYNC_STEEL_API_HOST': JSON.stringify('FORGESTEEL_SYNC_STEEL_API_HOST')
	},
	plugins: [
		// Sync Steel's live hero drawers in place of upstream's, behind the Live panels switch
		livePanels(),
		...(base.plugins ?? []),
		syncSteelBranding()
	]
});
