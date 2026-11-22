import { createHash } from 'node:crypto';

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject => {
	return (typeof value === 'object') && (value !== null) && !Array.isArray(value);
};

// Key order doesn't matter, so an unchanged hero echoed back by a client hashes the same
export const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (isObject(value)) {
		const entries = Object.keys(value)
			.filter(key => value[key] !== undefined)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

export const hashOf = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
