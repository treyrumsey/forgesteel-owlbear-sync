import { ImportSummary } from '@/sync-steel/api/sync-steel-api';

// Downloads, uploads and wording for the GM's room files

export class SyncSteelFiles {
	static download = (bytes: ArrayBuffer, filename: string) => {
		const url = window.URL.createObjectURL(new Blob([ bytes ], { type: 'application/gzip' }));
		const a = document.createElement('a');
		a.download = filename;
		a.href = url;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		window.setTimeout(() => window.URL.revokeObjectURL(url), 10000);
	};

	static describeImport = (summary: ImportSummary) => {
		const parts = [
			`Heroes: ${summary.heroes.created} new, ${summary.heroes.updated} changed, ${summary.heroes.unchanged} unchanged`,
			`Homebrew: ${summary.homebrew.created} new, ${summary.homebrew.updated} changed, ${summary.homebrew.unchanged} unchanged`,
			`Seats: ${summary.seats.matched} matched, ${summary.seats.created} new`
		];
		const skipped = summary.heroes.skipped + summary.homebrew.skipped;
		if (skipped > 0) {
			parts.push(`${skipped} skipped`);
		}
		return parts;
	};

	static importChangesNothing = (summary: ImportSummary) => {
		return (summary.heroes.created + summary.heroes.updated + summary.homebrew.created + summary.homebrew.updated + summary.seats.created + summary.seatData.updated) === 0;
	};

	// Days since the last export, or null if the room was never exported
	static daysSince = (iso: string | null, now: number) => {
		if (!iso) {
			return null;
		}
		return Math.floor((now - Date.parse(iso)) / (24 * 60 * 60 * 1000));
	};

	static formatDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
}
