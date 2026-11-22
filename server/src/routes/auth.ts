import { type AppEnv, type Principal, type Services } from '../services.ts';
import { HttpError, clientIp, fail, getBearerToken } from '../http.ts';
import { type JwtClaims, type TokenType, createJwt, verifyJwt } from '../jwt.ts';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { randomUUID } from 'node:crypto';

// Forge Steel uses POST /connect when the major version is 1 or more
export const API_VERSION = '1.1.0';

export const DATA_KEYS = [ 'forgesteel-heroes', 'forgesteel-homebrew-settings', 'forgesteel-session', 'forgesteel-hidden-setting-ids' ];

const REVOKED_MESSAGE = 'This device has been removed from the room. Join again with the room code.';

const nowSeconds = (s: Services) => Math.floor(s.now() / 1000);

const issueToken = (s: Services, claims: Omit<JwtClaims, 'type' | 'iat' | 'exp'>, type: TokenType) => {
	const iat = nowSeconds(s);
	const exp = iat + (type === 'access' ? s.accessTokenTtlSeconds : s.refreshTokenTtlSeconds);
	return createJwt({ ...claims, type: type, iat: iat, exp: exp }, type === 'access' ? s.secrets.jwt : s.secrets.jwtRefresh);
};

// Error bodies match flask-jwt-extended, which the reference Warehouse uses.
// Forge Steel refreshes and retries only on 401 {"msg": "Token has expired"}.
const verify = (s: Services, header: string | undefined, type: TokenType) => {
	const token = getBearerToken(header);
	if (!token) {
		throw new HttpError(401, { msg: 'Missing Authorization Header' });
	}

	const result = verifyJwt(token, type === 'access' ? s.secrets.jwt : s.secrets.jwtRefresh, nowSeconds(s));
	if (!result.ok) {
		if (result.reason === 'expired') {
			throw new HttpError(401, { msg: 'Token has expired' });
		}
		throw new HttpError(422, { msg: 'Signature verification failed' });
	}
	if (result.claims.type !== type) {
		throw new HttpError(422, { msg: type === 'access' ? 'Only non-refresh tokens are allowed' : 'Only refresh tokens are allowed' });
	}
	return result.claims;
};

// Revocation takes effect on the device's next request, not when its access token expires
const loadPrincipal = (s: Services, claims: JwtClaims): Principal => {
	const device = s.rooms.getDevice(claims.did);
	const seat = device ? s.rooms.getSeat(device.seat_id) : undefined;
	if (!device || !seat || (seat.id !== claims.sub) || (seat.room_id !== claims.room)) {
		throw fail(401, 'This device is no longer part of the room. Join again with the room code.');
	}
	if (device.revoked_at) {
		throw fail(401, REVOKED_MESSAGE);
	}
	return { roomId: seat.room_id, seatId: seat.id, seatName: seat.name, isGm: seat.is_gm === 1, deviceId: device.id, sid: claims.sid };
};

export const requireDevice = (s: Services) => createMiddleware<AppEnv>(async (c, next) => {
	c.set('principal', loadPrincipal(s, verify(s, c.req.header('authorization'), 'access')));
	await next();
});

export const requireGm = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.get('principal').isGm) {
		throw fail(403, 'Only the GM can do that');
	}
	await next();
});

export const authRoutes = (s: Services) => {
	const app = new Hono<AppEnv>();
	const device = requireDevice(s);

	app.get('/healthz', c => c.json({ version: API_VERSION }));

	app.post('/connect', c => {
		const ip = clientIp(c, s.trustProxy);
		s.limit(`connect:${ip}`, s.rateLimits.connect);
		s.checkFailures(`connect-fail:${ip}`, s.rateLimits.connectFailures);

		const challenge = { 'WWW-Authenticate': 'Bearer realm="Authorization required"' };
		const token = getBearerToken(c.req.header('authorization'));
		if (!token) {
			throw fail(400, 'Token required', challenge);
		}
		const found = s.rooms.findDeviceByTokenHash(s.hashSecret('device', token));
		if (!found) {
			s.limiter.record(`connect-fail:${ip}`, s.rateLimits.connectFailures);
			throw fail(401, 'Invalid token', challenge);
		}
		if (found.revoked_at) {
			throw fail(401, REVOKED_MESSAGE, challenge);
		}

		const seat = s.rooms.getSeat(found.seat_id);
		if (!seat) {
			throw fail(401, 'Invalid token', challenge);
		}
		s.rooms.touchDevice(found.id);
		s.log(`  device "${found.label}" connected as seat "${seat.name}"`);

		const claims = { sub: seat.id, room: seat.room_id, did: found.id, sid: randomUUID() };
		return c.json({ access_token: issueToken(s, claims, 'access'), refresh_token: issueToken(s, claims, 'refresh') });
	});

	app.post('/refresh', c => {
		const claims = verify(s, c.req.header('authorization'), 'refresh');
		loadPrincipal(s, claims);
		return c.json({ access_token: issueToken(s, { sub: claims.sub, room: claims.room, did: claims.did, sid: claims.sid }, 'access') });
	});

	app.get('/me', device, c => {
		const principal = c.get('principal');
		const room = s.rooms.getRoom(principal.roomId);
		return c.json({
			logged_in_as: principal.seatName,
			room: { id: principal.roomId, name: room?.name ?? '' },
			seat: { id: principal.seatId, name: principal.seatName, isGm: principal.isGm }
		});
	});

	app.get('/data', device, c => c.json({ keys: DATA_KEYS }));

	return app;
};
