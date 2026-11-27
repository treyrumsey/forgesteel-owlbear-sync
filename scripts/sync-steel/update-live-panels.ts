// Remakes Sync Steel's live copies of upstream's hero drawers (src/sync-steel/panels/copies/) from the
// current upstream files. Run it from the repository root when panels.test.ts says a copy is out of date:
//
//   node scripts/sync-steel/update-live-panels.ts
//
// Then review the diff: upstream's own changes come along, and the three "Sync Steel:" changes are re-applied.

import { LIVE_PANEL_COPIES, copyPath, liveCopy, upstreamPath } from '../../src/sync-steel/panels/live-copy.ts';
import { readFileSync, writeFileSync } from 'node:fs';

LIVE_PANEL_COPIES.forEach(panel => {
	const copy = liveCopy(panel, readFileSync(upstreamPath(panel), 'utf8'));
	const changed = readFileSync(copyPath(panel), 'utf8') !== copy;
	writeFileSync(copyPath(panel), copy);
	process.stdout.write(`${copyPath(panel)}: ${changed ? 'updated' : 'already up to date'}\n`);
});
