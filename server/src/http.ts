import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isObject } from './json.ts';
import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
	status: number;
	body: unknown;
	headers: Record<string, string>;

	constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
		super(`HTTP ${status}`);
		this.status = status;
		this.body = body;
		this.headers = headers;
	}
}

// Forge Steel shows the reference Warehouse's {message} text to the user
export const fail = (status: number, message: string, headers?: Record<string, string>) => {
	return new HttpError(status, { message: message }, headers);
};

export const getBearerToken = (header: string | undefined) => {
	const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
	return match ? match[1] : null;
};

export const readJson = async (c: Context): Promise<unknown> => {
	const text = await c.req.text();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw fail(400, 'Invalid JSON');
	}
};

export const readObject = async (c: Context) => {
	const body = await readJson(c);
	if (!isObject(body)) {
		throw fail(400, 'Expected a JSON object');
	}
	return body;
};

// A trimmed, non-empty, single-line name, such as a seat or device label
export const requireName = (value: unknown, field: string, maxLength = 60) => {
	const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
	if (!name) {
		throw fail(400, `${field} is required`);
	}
	if (name.length > maxLength) {
		throw fail(400, `${field} must be at most ${maxLength} characters`);
	}
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(name)) {
		throw fail(400, `${field} contains invalid characters`);
	}
	return name;
};

export const optionalString = (value: unknown) => (typeof value === 'string') && (value.length > 0) ? value : null;

// Behind Railway's proxy the client address is in X-Real-IP; elsewhere that header can be forged
export const clientIp = (c: Context, trustProxy: boolean) => {
	if (trustProxy) {
		const realIp = c.req.header('x-real-ip')?.trim();
		if (realIp) {
			return realIp;
		}
	}
	try {
		return getConnInfo(c).remote.address ?? 'unknown';
	} catch {
		return 'unknown';
	}
};

export const sameHash = (a: string, b: string) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return (left.length === right.length) && timingSafeEqual(left, right);
};
