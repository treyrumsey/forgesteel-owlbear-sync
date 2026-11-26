// A hero's table stats, as the api's hub sends them (server/src/summary.ts, from the fork's HeroSummaryLogic)

export interface SummaryCondition {
	id: string;
	type: string;
	text: string;
	ends: string;
}

export interface HeroSummary {
	heroId: string;
	// The hero's revision this summary was computed at
	rev: number;
	seatName: string;
	name: string;
	staminaMax: number;
	stamina: number;
	staminaTemp: number;
	recoveriesMax: number;
	recoveries: number;
	surges: number;
	resource: { featureId: string, name: string, value: number } | null;
	conditions: SummaryCondition[];
}

const isFiniteNumber = (value: unknown) => (typeof value === 'number') && Number.isFinite(value);

// Checks a summary from the wire before anything is written to a token
export const readSummary = (value: unknown): HeroSummary | null => {
	if ((typeof value !== 'object') || (value === null)) {
		return null;
	}
	const s = value as Record<string, unknown>;
	const numbers = [ 'rev', 'staminaMax', 'stamina', 'staminaTemp', 'recoveriesMax', 'recoveries', 'surges' ];
	if ((typeof s.heroId !== 'string') || (typeof s.name !== 'string') || !numbers.every(field => isFiniteNumber(s[field]))) {
		return null;
	}
	const resource = s.resource as Record<string, unknown> | null | undefined;
	const validResource = resource && (typeof resource.featureId === 'string') && (typeof resource.name === 'string') && isFiniteNumber(resource.value);
	const conditions = Array.isArray(s.conditions) ? s.conditions : [];
	return {
		heroId: s.heroId,
		rev: s.rev as number,
		seatName: typeof s.seatName === 'string' ? s.seatName : '',
		name: s.name,
		staminaMax: s.staminaMax as number,
		stamina: s.stamina as number,
		staminaTemp: s.staminaTemp as number,
		recoveriesMax: s.recoveriesMax as number,
		recoveries: s.recoveries as number,
		surges: s.surges as number,
		resource: validResource ? { featureId: resource.featureId as string, name: resource.name as string, value: resource.value as number } : null,
		conditions: conditions
			.filter((c): c is Record<string, unknown> => (typeof c === 'object') && (c !== null) && (typeof (c as Record<string, unknown>).id === 'string'))
			.map(c => ({
				id: c.id as string,
				type: typeof c.type === 'string' ? c.type : '',
				text: typeof c.text === 'string' ? c.text : '',
				ends: typeof c.ends === 'string' ? c.ends : ''
			}))
	};
};
