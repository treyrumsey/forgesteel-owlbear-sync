import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type JwtClaims, type TokenType, createJwt, verifyJwt } from './jwt.ts';
import { createHash, randomUUID } from 'node:crypto';

// A Phase 0 stub of the Forge Steel Warehouse API (report §4.3), in memory only.
// Response shapes follow the reference Warehouse (Veritas1000/forgesteel-warehouse@25f24db),
// so Forge Steel's unmodified WarehouseService can use it.

// Forge Steel uses POST /connect when the major version is 1 or more
export const STUB_VERSION = '1.0.0-stub';

const DATA_KEYS = [ 'forgesteel-heroes', 'forgesteel-homebrew-settings', 'forgesteel-session', 'forgesteel-hidden-setting-ids' ];

// Forge Steel adds X-NO-RETRY when it retries a request after refreshing an expired token
const ALLOWED_HEADERS = 'Authorization, Content-Type, X-CSRF-TOKEN, X-NO-RETRY';
const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

export interface StubServerOptions {
	// Device token -> seat name. Several devices can share a seat.
	deviceTokens: Record<string, string>;
	corsOrigins: string[];
	jwtSecret: string;
	accessTokenTtlSeconds?: number;
	refreshTokenTtlSeconds?: number;
	maxBodyBytes?: number;
	now?: () => number;
	log?: (line: string) => void;
}

type JsonObject = Record<string, unknown>;

interface StoredHero {
	data: JsonObject;
	rev: number;
	// The first revision of this copy of the hero; a base older than this belongs to a deleted copy
	createdRev: number;
	hash: string;
}

interface SeatData {
	heroes: Map<string, StoredHero>;
	// The highest revision ever used per hero id. Kept after a delete, so revision numbers are never reused.
	lastRevs: Map<string, number>;
	// Hero id -> session id -> the revision that session's last write produced or matched
	sessionWrites: Map<string, Map<string, number>>;
	homebrew: Map<string, JsonObject>;
	session: unknown;
	hiddenSettingIDs: unknown;
}

interface Reply {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

class HttpError extends Error {
	reply: Reply;

	constructor(status: number, body: unknown, headers?: Record<string, string>) {
		super(`HTTP ${status}`);
		this.reply = { status: status, body: body, headers: headers };
	}
}

const isObject = (value: unknown): value is JsonObject => {
	return (typeof value === 'object') && (value !== null) && !Array.isArray(value);
};

// Key order doesn't matter, so an unchanged hero echoed back by a client hashes the same
const canonicalJson = (value: unknown): string => {
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

const hashOf = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

const getBearerToken = (req: IncomingMessage) => {
	const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
	return match ? match[1] : null;
};

const readBody = (req: IncomingMessage, maxBytes: number) => {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size <= maxBytes) {
				chunks.push(chunk);
			}
		});
		req.on('end', () => {
			if (size > maxBytes) {
				reject(new HttpError(413, { message: 'Payload too large' }));
			} else {
				resolve(Buffer.concat(chunks).toString('utf8'));
			}
		});
		req.on('error', reject);
	});
};

export const createStubServer = (options: StubServerOptions): Server => {
	const accessTokenTtl = options.accessTokenTtlSeconds ?? 15 * 60;
	const refreshTokenTtl = options.refreshTokenTtlSeconds ?? 30 * 24 * 60 * 60;
	const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => undefined);
	const deviceTokens = new Map(Object.entries(options.deviceTokens));
	const seats = new Map<string, SeatData>();

	const getSeat = (name: string) => {
		let seat = seats.get(name);
		if (!seat) {
			seat = { heroes: new Map(), lastRevs: new Map(), sessionWrites: new Map(), homebrew: new Map(), session: null, hiddenSettingIDs: null };
			seats.set(name, seat);
		}
		return seat;
	};

	const nowSeconds = () => Math.floor(now() / 1000);

	const issueToken = (seat: string, sid: string, type: TokenType) => {
		const iat = nowSeconds();
		const exp = iat + (type === 'access' ? accessTokenTtl : refreshTokenTtl);
		return createJwt({ sub: seat, sid: sid, type: type, iat: iat, exp: exp }, options.jwtSecret);
	};

	// Error bodies match flask-jwt-extended, which the reference Warehouse uses.
	// Forge Steel refreshes and retries only on 401 {"msg": "Token has expired"}.
	const authenticate = (req: IncomingMessage, type: TokenType): JwtClaims => {
		const token = getBearerToken(req);
		if (!token) {
			throw new HttpError(401, { msg: 'Missing Authorization Header' });
		}

		const result = verifyJwt(token, options.jwtSecret, nowSeconds());
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

	const readJson = async (req: IncomingMessage) => {
		const text = await readBody(req, maxBodyBytes);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new HttpError(400, { message: 'Invalid JSON' });
		}
	};

	const stampHero = (hero: StoredHero) => ({ ...hero.data, _syncSteel: { rev: hero.rev } });

	// Forge Steel ignores the PUT response, so a client keeps the stamp from when it loaded the hero.
	// Its own later writes are also ancestors of its copy, so the merge base is the later of the two.
	const putHero = (seat: SeatData, sid: string, id: string, body: unknown): Reply => {
		if (!isObject(body) || (body.id !== id)) {
			return { status: 400, body: 'Hero id must be present and match the url' };
		}

		const { _syncSteel: stamp, ...data } = body;
		const stampRev = isObject(stamp) && (typeof stamp.rev === 'number') ? stamp.rev : null;
		let sessionWrites = seat.sessionWrites.get(id);
		if (!sessionWrites) {
			sessionWrites = new Map();
			seat.sessionWrites.set(id, sessionWrites);
		}
		const sessionRev = sessionWrites.get(sid) ?? null;
		const candidates = [ stampRev, sessionRev ].filter(rev => rev !== null);
		const baseRev = candidates.length > 0 ? Math.max(...candidates) : null;
		const hash = hashOf(data);
		const existing = seat.heroes.get(id);
		const label = `hero ${id} "${typeof data.name === 'string' ? data.name : ''}"`;
		const baseText = `stamp rev ${stampRev ?? 'none'}, session wrote rev ${sessionRev ?? 'none'}, base rev ${baseRev ?? 'none'}`;

		if (existing && (existing.hash === hash)) {
			sessionWrites.set(sid, existing.rev);
			log(`  ${label} unchanged at rev ${existing.rev} (${baseText})`);
			return { status: 204 };
		}

		const previousRev = seat.lastRevs.get(id) ?? 0;
		const rev = previousRev + 1;
		seat.lastRevs.set(id, rev);
		seat.heroes.set(id, { data: data, rev: rev, createdRev: existing ? existing.createdRev : rev, hash: hash });
		sessionWrites.set(sid, rev);

		// Phase 3 replaces last-writer-wins with a three-way merge against the base revision (report §4.4)
		let warning = '';
		if (!existing && (previousRev > 0)) {
			warning = ' WARNING: re-creates a deleted hero';
		} else if (existing && (baseRev === null)) {
			warning = ' WARNING: no base for an update';
		} else if (existing && (baseRev !== null) && (baseRev < existing.createdRev)) {
			warning = ` WARNING: base predates this hero's re-creation at rev ${existing.createdRev}`;
		} else if (existing && (baseRev !== null) && (baseRev < existing.rev)) {
			warning = ` WARNING: stale base (current was rev ${existing.rev})`;
		}
		log(`  ${label} rev ${existing?.rev ?? 0} -> ${rev} (${baseText})${warning}`);
		return { status: 204 };
	};

	const heroes = async (req: IncomingMessage, url: URL, seat: SeatData, sid: string, id: string | undefined): Promise<Reply> => {
		if (id === undefined) {
			if (req.method !== 'GET') {
				throw new HttpError(405, { message: 'Method not allowed' });
			}
			const fields = url.searchParams.get('fields');
			const list = [ ...seat.heroes.values() ].map(hero => {
				if (fields === null) {
					return stampHero(hero);
				}
				const partial: JsonObject = { id: hero.data.id };
				fields.split(',')
					.filter(field => field in hero.data)
					.forEach(field => partial[field] = hero.data[field]);
				return partial;
			});
			return { status: 200, body: { data: list } };
		}

		const hero = seat.heroes.get(id);
		switch (req.method) {
			case 'GET':
				if (!hero) {
					throw new HttpError(404, { message: 'Not found' });
				}
				return { status: 200, body: { data: stampHero(hero) } };
			case 'PUT':
				return putHero(seat, sid, id, await readJson(req));
			case 'DELETE':
				if (!hero) {
					throw new HttpError(404, { message: 'Not found' });
				}
				seat.heroes.delete(id);
				seat.sessionWrites.delete(id);
				return { status: 204 };
			default:
				throw new HttpError(405, { message: 'Method not allowed' });
		}
	};

	const homebrew = async (req: IncomingMessage, seat: SeatData, id: string | undefined): Promise<Reply> => {
		if (id === undefined) {
			if (req.method !== 'GET') {
				throw new HttpError(405, { message: 'Method not allowed' });
			}
			return { status: 200, body: { data: [ ...seat.homebrew.values() ] } };
		}

		const sourcebook = seat.homebrew.get(id);
		switch (req.method) {
			case 'GET':
				if (!sourcebook) {
					throw new HttpError(404, { message: 'Not found' });
				}
				return { status: 200, body: { data: sourcebook } };
			case 'PUT': {
				const body = await readJson(req);
				if (!isObject(body) || (body.id !== id)) {
					return { status: 400, body: 'Homebrew id must be present and match the url' };
				}
				seat.homebrew.set(id, body);
				return { status: 204 };
			}
			case 'DELETE':
				if (!sourcebook) {
					throw new HttpError(404, { message: 'Not found' });
				}
				seat.homebrew.delete(id);
				return { status: 204 };
			default:
				throw new HttpError(405, { message: 'Method not allowed' });
		}
	};

	const singleValue = async (req: IncomingMessage, seat: SeatData, field: 'session' | 'hiddenSettingIDs'): Promise<Reply> => {
		switch (req.method) {
			case 'GET':
				return { status: 200, body: { data: seat[field] } };
			case 'PUT':
				seat[field] = await readJson(req);
				return { status: 204 };
			default:
				throw new HttpError(405, { message: 'Method not allowed' });
		}
	};

	const dispatch = async (req: IncomingMessage, url: URL): Promise<Reply> => {
		let segments: string[];
		try {
			segments = url.pathname.split('/').filter(s => s.length > 0).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, { message: 'Malformed URL' });
		}
		const method = req.method ?? 'GET';
		const route = `${method} /${segments.slice(0, 2).join('/')}`;

		switch (route) {
			case 'GET /healthz':
				return { status: 200, body: { version: STUB_VERSION } };
			case 'POST /connect': {
				const token = getBearerToken(req);
				const challenge = { 'WWW-Authenticate': 'Bearer realm="Authorization required"' };
				if (!token) {
					throw new HttpError(400, { message: 'Token required' }, challenge);
				}
				const seat = deviceTokens.get(token);
				if (!seat) {
					throw new HttpError(401, { message: 'Invalid token' }, challenge);
				}
				log(`  device connected as seat "${seat}"`);
				const sid = randomUUID();
				return { status: 200, body: { access_token: issueToken(seat, sid, 'access'), refresh_token: issueToken(seat, sid, 'refresh') } };
			}
			case 'POST /refresh': {
				const claims = authenticate(req, 'refresh');
				return { status: 200, body: { access_token: issueToken(claims.sub, claims.sid, 'access') } };
			}
			case 'GET /me':
				return { status: 200, body: { logged_in_as: authenticate(req, 'access').sub } };
			case 'GET /data':
				authenticate(req, 'access');
				return { status: 200, body: { keys: DATA_KEYS } };
		}

		if ((segments[0] === 'data') && (segments.length >= 2) && (segments.length <= 3)) {
			const claims = authenticate(req, 'access');
			const seat = getSeat(claims.sub);
			const id = segments[2];
			switch (segments[1]) {
				case 'forgesteel-heroes':
					return heroes(req, url, seat, claims.sid, id);
				case 'forgesteel-homebrew-settings':
					return homebrew(req, seat, id);
				case 'forgesteel-session':
					if (id === undefined) {
						return singleValue(req, seat, 'session');
					}
					break;
				case 'forgesteel-hidden-setting-ids':
					if (id === undefined) {
						return singleValue(req, seat, 'hiddenSettingIDs');
					}
					break;
				default:
					throw new HttpError(404, { message: `Unknown data key: ${segments[1]}` });
			}
		}

		throw new HttpError(404, { message: 'Not found' });
	};

	// Credentialed requests (Forge Steel's connection test) need the exact origin, never '*'
	const applyCors = (req: IncomingMessage, res: ServerResponse) => {
		const origin = req.headers.origin;
		if (!origin || !options.corsOrigins.includes(origin)) {
			return false;
		}
		res.setHeader('Access-Control-Allow-Origin', origin);
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Vary', 'Origin');
		return true;
	};

	const send = (res: ServerResponse, reply: Reply) => {
		Object.entries(reply.headers ?? {}).forEach(([ name, value ]) => res.setHeader(name, value));
		if (reply.body === undefined) {
			res.writeHead(reply.status).end();
		} else if (typeof reply.body === 'string') {
			res.writeHead(reply.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(reply.body);
		} else {
			res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
		}
	};

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		let path = req.url ?? '/';
		const corsAllowed = applyCors(req, res);

		if (req.method === 'OPTIONS') {
			if (!corsAllowed) {
				send(res, { status: 403 });
			} else {
				res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
				res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
				res.setHeader('Access-Control-Max-Age', '600');
				if (req.headers['access-control-request-private-network'] === 'true') {
					res.setHeader('Access-Control-Allow-Private-Network', 'true');
				}
				send(res, { status: 204 });
			}
		} else {
			try {
				let url: URL;
				try {
					url = new URL(path, 'http://stub.invalid');
				} catch {
					// Node's parser accepts some request targets (e.g. `http://[`) that URL can't parse
					throw new HttpError(400, { message: 'Malformed URL' });
				}
				path = `${url.pathname}${url.search}`;
				send(res, await dispatch(req, url));
			} catch (error) {
				if (error instanceof HttpError) {
					send(res, error.reply);
				} else {
					log(`  error: ${error instanceof Error ? error.stack : String(error)}`);
					send(res, { status: 500, body: { message: 'Internal server error' } });
				}
			}
		}

		log(`${new Date().toISOString()} ${req.headers.origin ?? '-'} ${req.method} ${path} ${res.statusCode}`);
	};

	return createServer((req, res) => {
		// Nothing a client sends may take the process down
		handle(req, res).catch(error => {
			log(`  error: ${error instanceof Error ? error.stack : String(error)}`);
			if (res.headersSent) {
				res.destroy();
			} else {
				res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Internal server error' }));
			}
		});
	});
};
