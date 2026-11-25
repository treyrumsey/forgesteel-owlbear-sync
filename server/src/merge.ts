import { type JsonObject, canonicalJson, isObject } from './json.ts';

// The three-way hero merge (report §4.4, decisions.md "Phase 3"). A save is merged against the revision
// it was based on, so a stale or concurrent copy can't undo another device's change:
// - a part the saving device didn't change keeps the server's current value;
// - a part it did change takes its value (last writer wins, including over a concurrent change);
// - top-level parts are atomic, except `state`, whose fields merge one by one;
// - `state.conditions` merges as a set by condition id;
// - heroic resource values merge by feature id, wherever the feature sits in the hero;
// - counters (stamina damage, temporary stamina, recoveries used, surges and heroic resource values) that
//   both sides changed combine: the server's value plus this save's change from its base. A GM's +4
//   temporary stamina and a player's 1 damage taken from it, at the same time, give +3.

export interface MergeResult {
	merged: JsonObject;
	// Paths that both the saving device and the server changed, to different values; the saving device won
	conflicts: string[];
}

const HEROIC_RESOURCE = 'Heroic Resource';

export const COUNTERS = [ 'staminaDamage', 'staminaTemp', 'recoveriesUsed', 'surges' ];

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

const has = (object: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(object, key) && (object[key] !== undefined);

// One key, three ways. Returns undefined when the merged object shouldn't have the key.
const mergeValue = (path: string, key: string, base: JsonObject, current: JsonObject, incoming: JsonObject, conflicts: string[]) => {
	if (same(incoming[key], base[key])) {
		return has(current, key) ? current[key] : undefined;
	}
	if (!same(current[key], base[key]) && !same(current[key], incoming[key])) {
		conflicts.push(`${path}${key}`);
	}
	return has(incoming, key) ? incoming[key] : undefined;
};

const isNumber = (value: unknown): value is number => (typeof value === 'number') && Number.isFinite(value);

// A counter both sides changed takes both changes; otherwise it's an ordinary value
const mergeCounter = (path: string, key: string, base: JsonObject, current: JsonObject, incoming: JsonObject, conflicts: string[]) => {
	const [ b, c, i ] = [ base[key], current[key], incoming[key] ];
	if (isNumber(b) && isNumber(c) && isNumber(i) && (c !== b) && (i !== b)) {
		return c + (i - b);
	}
	return mergeValue(path, key, base, current, incoming, conflicts);
};

const keysOf = (...objects: JsonObject[]) => {
	const keys: string[] = [];
	objects.forEach(object => Object.keys(object).forEach(key => {
		if (!keys.includes(key)) {
			keys.push(key);
		}
	}));
	return keys;
};

const mergeObjects = (path: string, base: JsonObject, current: JsonObject, incoming: JsonObject, conflicts: string[], special: Record<string, () => unknown>) => {
	const merged: JsonObject = {};
	// Incoming key order first, so an unconflicted save comes back looking as it was sent
	keysOf(incoming, current, base).forEach(key => {
		const value = special[key] ? special[key]() : mergeValue(path, key, base, current, incoming, conflicts);
		if (value !== undefined) {
			merged[key] = value;
		}
	});
	return merged;
};

type Identified = JsonObject & { id: string };

const byId = (list: unknown): Map<string, Identified> | null => {
	if (!Array.isArray(list)) {
		return null;
	}
	const map = new Map<string, Identified>();
	for (const item of list) {
		if (!isObject(item) || (typeof item.id !== 'string') || map.has(item.id)) {
			return null;
		}
		map.set(item.id, item as Identified);
	}
	return map;
};

// Conditions as a set by id. Either side's additions are kept; a removal by either side is kept unless the
// other side changed that condition; for a condition both kept, the usual rule applies.
const mergeConditions = (base: unknown, current: unknown, incoming: unknown, conflicts: string[]) => {
	const b = byId(base);
	const c = byId(current);
	const i = byId(incoming);
	if (!b || !c || !i) {
		return mergeValue('state.', 'conditions', { conditions: base }, { conditions: current }, { conditions: incoming }, conflicts);
	}

	const merged: unknown[] = [];
	const keep = (id: string) => {
		const inBase = b.get(id);
		const inCurrent = c.get(id);
		const inIncoming = i.get(id);
		if (inIncoming && inCurrent) {
			return mergeValue('state.conditions.', id, { [id]: inBase }, { [id]: inCurrent }, { [id]: inIncoming }, conflicts);
		}
		if (inIncoming) {
			// Not on the server: new from the saving device, or removed there. A removal stands unless this device changed it.
			return (!inBase || !same(inIncoming, inBase)) ? inIncoming : undefined;
		}
		if (inCurrent) {
			// Not in the save: new on the server, or removed by the saving device. Same rule the other way round.
			return (!inBase || !same(inCurrent, inBase)) ? inCurrent : undefined;
		}
		return undefined;
	};
	keysOf(Object.fromEntries(i), Object.fromEntries(c)).forEach(id => {
		const value = keep(id);
		if (value !== undefined) {
			merged.push(value);
		}
	});
	return merged;
};

// Every heroic resource feature in the hero, by feature id (the first one, if an id repeats)
const findResources = (value: unknown, found = new Map<string, JsonObject[]>()) => {
	if (Array.isArray(value)) {
		value.forEach(item => findResources(item, found));
	} else if (isObject(value)) {
		if ((value.type === HEROIC_RESOURCE) && (typeof value.id === 'string') && isObject(value.data)) {
			found.set(value.id, [ ...(found.get(value.id) ?? []), value ]);
		}
		Object.values(value).forEach(child => findResources(child, found));
	}
	return found;
};

const resourceValue = (resources: Map<string, JsonObject[]>, id: string) => {
	const feature = resources.get(id)?.[0];
	return feature && isObject(feature.data) ? feature.data.value : undefined;
};

// A resource the saving device didn't change keeps the server's value, even inside a part it did change
const mergeResources = (merged: JsonObject, base: JsonObject, current: JsonObject, incoming: JsonObject, conflicts: string[]) => {
	const inBase = findResources(base);
	const inCurrent = findResources(current);
	const inIncoming = findResources(incoming);
	findResources(merged).forEach((features, id) => {
		if (!inBase.has(id) || !inCurrent.has(id) || !inIncoming.has(id)) {
			return;
		}
		const value = mergeCounter('resource.', id, { [id]: resourceValue(inBase, id) }, { [id]: resourceValue(inCurrent, id) }, { [id]: resourceValue(inIncoming, id) }, conflicts);
		if (value !== undefined) {
			features.forEach(feature => {
				feature.data = { ...(feature.data as JsonObject), value: value };
			});
		}
	});
};

// All three are heroes without their _syncSteel stamps. Nothing passed in is modified.
export const mergeHero = (base: JsonObject, current: JsonObject, incoming: JsonObject): MergeResult => {
	const conflicts: string[] = [];
	const special: Record<string, () => unknown> = {};
	if (isObject(base.state) && isObject(current.state) && isObject(incoming.state)) {
		const [ bs, cs, is ] = [ base.state, current.state, incoming.state ];
		const counters = Object.fromEntries(COUNTERS.map(key => [ key, () => mergeCounter('state.', key, bs, cs, is, conflicts) ]));
		special.state = () => mergeObjects('state.', bs, cs, is, conflicts, {
			...counters,
			conditions: () => mergeConditions(bs.conditions, cs.conditions, is.conditions, conflicts)
		});
	}
	const merged = structuredClone(mergeObjects('', base, current, incoming, conflicts, special));
	mergeResources(merged, base, current, incoming, conflicts);
	return { merged: merged, conflicts: conflicts };
};
