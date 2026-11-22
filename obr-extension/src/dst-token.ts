// Draw Steel Tools 2 hero token data, as validated by its zod schema at
// SeamusFinlayson/draw-steel-tools-2@a445eb9 src/types/tokenDataZod.ts (zod 4).
// DST's parseTokenData throws on data that fails the schema, which breaks the token,
// so nothing here ever produces a non-finite number or a non-string text field.

export const DST_METADATA_KEY = 'com.draw-steel-stat-bubbles/metadata';

export type DstHeroicResourceButton = 'D3' | 'D3+1' | '+2' | '+3';

// Every field is optional in DST's HeroTokenDataZod; `type` is missing on older hero tokens
export interface DstHeroTokenData {
	type?: 'HERO';
	name?: string;
	gmOnly?: boolean;
	stamina?: number;
	staminaMaximum?: number;
	temporaryStamina?: number;
	heroicResource?: number;
	recoveries?: number;
	surges?: number;
	heroicResourceButton?: DstHeroicResourceButton;
	heroicResourceName?: string;
	notes?: string;
}

// The fields Sync Steel owns. `notes`, `gmOnly` and `heroicResourceButton` belong to the table and are never written.
export const SYNCED_FIELDS = [ 'name', 'stamina', 'staminaMaximum', 'temporaryStamina', 'heroicResource', 'heroicResourceName', 'recoveries', 'surges' ] as const;

export type DstSyncedField = typeof SYNCED_FIELDS[number];

export type DstSyncedFields = Pick<DstHeroTokenData, DstSyncedField>;

const NUMBER_FIELDS = [ 'stamina', 'staminaMaximum', 'temporaryStamina', 'heroicResource', 'recoveries', 'surges' ];
const STRING_FIELDS = [ 'name', 'heroicResourceName', 'notes' ];
const RESOURCE_BUTTONS = [ 'D3', 'D3+1', '+2', '+3' ];

export type DstTokenRead =
	| { kind: 'hero', data: DstHeroTokenData }
	| { kind: 'other', type: string }
	| { kind: 'none' }
	| { kind: 'invalid', problems: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return (typeof value === 'object') && (value !== null) && !Array.isArray(value);
};

// zod 4's z.number() rejects NaN and Infinity
const isValidNumber = (value: unknown) => (typeof value === 'number') && Number.isFinite(value);

const checkField = (field: string, value: unknown): string | null => {
	if (value === undefined) {
		return null;
	}
	if (NUMBER_FIELDS.includes(field) && !isValidNumber(value)) {
		return `${field} must be a finite number (got ${String(value)})`;
	}
	if (STRING_FIELDS.includes(field) && (typeof value !== 'string')) {
		return `${field} must be a string (got ${typeof value})`;
	}
	if ((field === 'gmOnly') && (typeof value !== 'boolean')) {
		return `gmOnly must be a boolean (got ${typeof value})`;
	}
	if ((field === 'heroicResourceButton') && !RESOURCE_BUTTONS.includes(value as string)) {
		return `heroicResourceButton must be one of ${RESOURCE_BUTTONS.join(', ')} (got ${String(value)})`;
	}
	return null;
};

// Reads a token's DST data the way DST would accept it: a HERO (or untyped) object whose known fields have the right types
export const readDstToken = (metadata: Record<string, unknown>): DstTokenRead => {
	const value = metadata[DST_METADATA_KEY];
	if (value === undefined) {
		return { kind: 'none' };
	}
	if (!isRecord(value)) {
		return { kind: 'invalid', problems: [ 'DST data is not an object' ] };
	}
	if ((value.type !== undefined) && (value.type !== 'HERO')) {
		return { kind: 'other', type: String(value.type) };
	}

	const problems = Object.entries(value)
		.map(([ field, fieldValue ]) => checkField(field, fieldValue))
		.filter(problem => problem !== null);
	if (problems.length > 0) {
		return { kind: 'invalid', problems: problems };
	}

	return { kind: 'hero', data: value as DstHeroTokenData };
};

export type DstPatchResult =
	| { ok: true, data: DstHeroTokenData, changed: DstSyncedField[] }
	| { ok: false, problems: string[] };

// Applies only the synced fields to a copy of the existing data, and reports which values actually changed
export const patchDstHeroData = (existing: DstHeroTokenData, patch: DstSyncedFields): DstPatchResult => {
	const problems = Object.entries(patch).map(([ field, value ]) => {
		if (!(SYNCED_FIELDS as readonly string[]).includes(field)) {
			return `${field} is not a field Sync Steel writes`;
		}
		return checkField(field, value);
	}).filter(problem => problem !== null);
	if (problems.length > 0) {
		return { ok: false, problems: problems };
	}

	const data: DstHeroTokenData = { ...existing };
	const changed: DstSyncedField[] = [];
	SYNCED_FIELDS.forEach(field => {
		const value = patch[field];
		if ((value !== undefined) && (data[field] !== value)) {
			(data as Record<string, unknown>)[field] = value;
			changed.push(field);
		}
	});

	return { ok: true, data: data, changed: changed };
};

// The parts of the server's hero summary (src/sync-steel/logic/hero-summary-logic.ts) that DST shows
export interface SyncSteelHeroSummary {
	name: string;
	staminaMax: number;
	stamina: number;
	staminaTemp: number;
	recoveries: number;
	surges: number;
	resource: { name: string, value: number } | null;
}

// Field mapping from report §4.9. A hero without a heroic resource leaves DST's resource fields alone.
export const summaryToDstPatch = (summary: SyncSteelHeroSummary): DstSyncedFields => {
	const patch: DstSyncedFields = {
		name: summary.name,
		staminaMaximum: summary.staminaMax,
		stamina: summary.stamina,
		temporaryStamina: summary.staminaTemp,
		recoveries: summary.recoveries,
		surges: summary.surges
	};
	if (summary.resource) {
		patch.heroicResource = summary.resource.value;
		patch.heroicResourceName = summary.resource.name;
	}
	return patch;
};
