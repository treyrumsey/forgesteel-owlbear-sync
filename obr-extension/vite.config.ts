import { type Plugin, defineConfig } from 'vite';

// The Owlbear extension. `npm run dev` serves it at http://localhost:5174/manifest.json (plus the Phase 0 spike
// page at /spike.html); `npm run build` builds it for fs-web, which serves it at https://syncsteel.app/owlbear/
// (Dockerfile.sync-steel).

// Owlbear Rodeo fetches manifest.json and the icons cross-origin from its own site
const cors = { origin: /^https:\/\/([a-z0-9-]+\.)*owlbear\.rodeo$/ };

// Owlbear checks the manifest when the extension is added; for example, a description over 128 characters is refused
export const manifest = (base: string) => ({
	name: 'Sync Steel',
	version: '1.0.0',
	manifest_version: 1,
	author: 'treyrumsey',
	homepage_url: 'https://github.com/treyrumsey/forgesteel-owlbear-sync',
	description: 'Keeps Draw Steel Tools tokens and Forge Steel heroes in step: stamina, recoveries, surges, heroic resource, conditions.',
	icon: `${base}icon.svg`,
	background_url: `${base}background.html`,
	action: {
		title: 'Sync Steel',
		icon: `${base}icon.svg`,
		popover: `${base}index.html`,
		height: 520,
		width: 380
	}
});

// The manifest's paths depend on where the extension is served, so it's generated rather than kept in public/
const owlbearManifest = (): Plugin => {
	let base = '/';
	return {
		name: 'sync-steel-owlbear-manifest',
		configResolved: config => {
			base = config.base;
		},
		configureServer: server => {
			server.middlewares.use('/manifest.json', (_request, response) => {
				response.setHeader('Content-Type', 'application/json');
				response.end(JSON.stringify(manifest(base), null, '\t'));
			});
		},
		generateBundle() {
			this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest(base), null, '\t') });
		}
	};
};

export default defineConfig(({ command }) => ({
	base: command === 'build' ? '/owlbear/' : '/',
	plugins: [ owlbearManifest() ],
	build: {
		rollupOptions: {
			// The spike page (spike.html) is for local testing only and isn't built
			input: {
				popover: 'index.html',
				background: 'background.html',
				picker: 'picker.html',
				conditionsEmbed: 'conditions-embed.html'
			}
		}
	},
	server: {
		port: 5174,
		strictPort: true,
		cors: cors
	},
	preview: {
		port: 5174,
		strictPort: true,
		cors: cors
	}
}));
