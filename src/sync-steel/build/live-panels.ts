// Swaps upstream's hero drawers for Sync Steel's switchers in the branded build (vite.sync-steel.config.ts
// runs this as a plugin), with no upstream file changed. Every import that resolves to one of upstream's
// drawer files gets the switcher instead (src/sync-steel/panels/), except the switcher's own import of the
// original. `npm start` uses upstream's config, so it keeps upstream's drawers.
//
// Plain path logic, so it's testable here; the config supplies Vite's resolver and the file checks.

import { LIVE_PANEL_COPIES, upstreamPath } from '../panels/live-copy.ts';

export const LIVE_PANELS = LIVE_PANEL_COPIES.map(panel => ({
	upstream: upstreamPath(panel),
	switcher: `src/sync-steel/panels/${panel.folder}-modal.tsx`
}));

const inRoot = (root: string, path: string) => `${root.replace(/\/+$/, '')}/${path}`;

// Vite ids can carry a query (?raw) and, on Windows, backslashes
const normalize = (id: string) => id.split('?')[0].replace(/\\/g, '/');

// Where an import that resolved to `resolvedId` from `importer` should go instead, if anywhere
export const redirectFor = (root: string, resolvedId: string, importer: string | undefined) => {
	const panel = LIVE_PANELS.find(p => inRoot(normalize(root), p.upstream) === normalize(resolvedId));
	if (!panel) {
		return null;
	}
	const switcher = inRoot(normalize(root), panel.switcher);
	return importer && (normalize(importer) === switcher) ? null : switcher;
};

// Every file the swap needs, relative to the root
export const livePanelFiles = () => LIVE_PANELS.flatMap(p => [ p.upstream, p.switcher ]);
