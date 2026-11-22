import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenType = 'access' | 'refresh';

export interface JwtClaims {
	// Seat id
	sub: string;
	room: string;
	// Device id, checked against revocation on every request
	did: string;
	// One id per /connect: the session's own writes are known ancestors of its copy of a hero
	sid: string;
	type: TokenType;
	iat: number;
	exp: number;
}

export type JwtVerification =
	| { ok: true, claims: JwtClaims }
	| { ok: false, reason: 'expired' | 'invalid' };

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

const sign = (data: string, secret: string) => {
	return createHmac('sha256', secret).update(data).digest('base64url');
};

const isClaims = (value: unknown): value is JwtClaims => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const claims = value as Record<string, unknown>;
	return (typeof claims.sub === 'string')
		&& (typeof claims.room === 'string')
		&& (typeof claims.did === 'string')
		&& (typeof claims.sid === 'string')
		&& ((claims.type === 'access') || (claims.type === 'refresh'))
		&& (typeof claims.iat === 'number')
		&& (typeof claims.exp === 'number');
};

// HS256 only. Forge Steel reads the `exp` claim to refresh early, so every token carries one.
export const createJwt = (claims: JwtClaims, secret: string) => {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	const data = `${HEADER}.${payload}`;
	return `${data}.${sign(data, secret)}`;
};

export const verifyJwt = (token: string, secret: string, nowSeconds: number): JwtVerification => {
	const parts = token.split('.');
	if ((parts.length !== 3) || (parts[0] !== HEADER)) {
		return { ok: false, reason: 'invalid' };
	}

	const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
	const actual = Buffer.from(parts[2]);
	if ((expected.length !== actual.length) || !timingSafeEqual(expected, actual)) {
		return { ok: false, reason: 'invalid' };
	}

	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch {
		return { ok: false, reason: 'invalid' };
	}

	if (!isClaims(claims)) {
		return { ok: false, reason: 'invalid' };
	}

	if (claims.exp <= nowSeconds) {
		return { ok: false, reason: 'expired' };
	}

	return { ok: true, claims: claims };
};
