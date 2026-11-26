import { defineConfig } from 'vite';

// Bundles Sync Steel's hero summary logic (and the upstream HeroLogic it uses) into one ESM file the api
// runs in Node. Node's type stripping can't run upstream's enums or `@/` imports, so the api can't import
// src/ directly.
//
//   npx vite build --config vite.sync-steel-summary.config.ts
//
// The output, server/build/hero-summary.mjs, is gitignored. server/Dockerfile builds it, and the api loads
// it at startup (server/src/summary.ts).

export default defineConfig({
	publicDir: false,
	resolve: {
		tsconfigPaths: true
	},
	build: {
		ssr: 'src/sync-steel/logic/hero-summary-logic.ts',
		outDir: 'server/build',
		emptyOutDir: true,
		target: 'node26',
		minify: false,
		sourcemap: false,
		// Bundle everything: the api image has no root node_modules
		ssrEmitAssets: false,
		rollupOptions: {
			output: {
				format: 'es',
				entryFileNames: 'hero-summary.mjs',
				codeSplitting: false
			}
		}
	},
	ssr: {
		noExternal: true,
		target: 'node'
	}
});
