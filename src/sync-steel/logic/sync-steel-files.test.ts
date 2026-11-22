import { describe, expect, it } from 'vitest';
import { ImportSummary } from '@/sync-steel/api/sync-steel-api';
import { SyncSteelFiles } from '@/sync-steel/logic/sync-steel-files';

const tally = (created = 0, updated = 0, unchanged = 0, skipped = 0) => ({ created, updated, unchanged, skipped });

const summary = (heroes = tally(), homebrew = tally()): ImportSummary => ({
	seats: { matched: 2, created: 0 },
	seatData: { updated: 0 },
	heroes: heroes,
	homebrew: homebrew
});

describe('SyncSteelFiles', () => {
	it('describes an import', () => {
		expect(SyncSteelFiles.describeImport(summary(tally(1, 2, 3), tally(0, 0, 1, 1)))).toEqual([
			'Heroes: 1 new, 2 changed, 3 unchanged',
			'Homebrew: 0 new, 0 changed, 1 unchanged',
			'Seats: 2 matched, 0 new',
			'1 skipped'
		]);
	});

	it('knows when an import would change nothing', () => {
		expect(SyncSteelFiles.importChangesNothing(summary(tally(0, 0, 4), tally(0, 0, 1)))).toBe(true);
		expect(SyncSteelFiles.importChangesNothing(summary(tally(0, 1, 3)))).toBe(false);
	});

	it('counts whole days since the last export', () => {
		const now = Date.parse('2026-11-22T12:00:00Z');
		expect(SyncSteelFiles.daysSince(null, now)).toBeNull();
		expect(SyncSteelFiles.daysSince('2026-11-22T01:00:00Z', now)).toBe(0);
		expect(SyncSteelFiles.daysSince('2026-11-14T11:00:00Z', now)).toBe(8);
	});
});
