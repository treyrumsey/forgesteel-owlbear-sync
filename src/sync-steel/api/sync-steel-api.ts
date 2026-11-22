import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

// A client for the Sync Steel api's own routes (server/README.md#api): creating and joining rooms,
// and the GM's tools. Heroes and homebrew don't go through here: Forge Steel's own WarehouseService
// stores them, using the device token this client obtains.

export interface SeatSummary {
	id: string;
	name: string;
	isGm: boolean;
}

export interface CreatedRoom {
	room: { id: string, name: string };
	seat: SeatSummary;
	joinCode: string;
	gmKey: string;
	deviceToken: string;
}

export interface RoomLookup {
	room: { name: string };
	seats: SeatSummary[];
}

export interface JoinRequest {
	code?: string;
	seatId?: string;
	newSeatName?: string;
	gmKey?: string;
	deviceLabel: string;
}

export interface JoinedRoom {
	room: { id: string, name: string };
	seat: SeatSummary;
	deviceToken: string;
}

export interface Me {
	room: { id: string, name: string };
	seat: SeatSummary;
}

export interface GmDevice {
	id: string;
	label: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	current: boolean;
}

export interface GmSeat extends SeatSummary {
	createdAt: string;
	devices: GmDevice[];
	heroes: { id: string, name: string, rev: number, updatedAt: string }[];
}

export interface GmRoom {
	room: { id: string, name: string, createdAt: string, codeRotatedAt: string | null, lastExportAt: string | null };
	seats: GmSeat[];
}

export interface ImportTally {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
}

export interface ImportSummary {
	seats: { matched: number, created: number };
	seatData: { updated: number };
	heroes: ImportTally;
	homebrew: ImportTally;
}

export interface ExportFile {
	filename: string;
	bytes: ArrayBuffer;
}

export class SyncSteelApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'SyncSteelApiError';
		this.status = status;
	}
}

const describeError = (error: unknown): Error => {
	if (!axios.isAxiosError(error)) {
		return error instanceof Error ? error : new Error(String(error));
	}
	const err = error as AxiosError;
	if (!err.response) {
		return new SyncSteelApiError(0, 'Couldn\'t reach the Sync Steel server. Check your connection and try again.');
	}
	let body: unknown = err.response.data;
	if (body instanceof ArrayBuffer) {
		try {
			body = JSON.parse(new TextDecoder().decode(body));
		} catch {
			body = null;
		}
	}
	const record = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
	const message = [ record.message, record.msg ].find(m => typeof m === 'string') as string | undefined;
	if (err.response.status === 429) {
		return new SyncSteelApiError(429, message ?? 'Too many attempts. Wait a minute and try again.');
	}
	return new SyncSteelApiError(err.response.status, message ?? `The server returned ${err.response.status}`);
};

const filenameFrom = (header: unknown, fallback: string) => {
	const match = /filename="?([^";]+)"?/i.exec(typeof header === 'string' ? header : '');
	return match ? match[1] : fallback;
};

const trimHost = (host: string) => host.trim().replace(/\/+$/, '');

// Room creation and joining need no device token
export class SyncSteelRoomApi {
	private http: AxiosInstance;

	constructor(host: string) {
		this.http = axios.create({ baseURL: trimHost(host) });
	}

	private async post<T>(path: string, body: unknown) {
		try {
			return (await this.http.post<T>(path, body)).data;
		} catch (error) {
			throw describeError(error);
		}
	}

	createRoom = (roomName: string, gmSeatName: string, deviceLabel: string) => {
		return this.post<CreatedRoom>('/rooms', { roomName: roomName, gmSeatName: gmSeatName, deviceLabel: deviceLabel });
	};

	lookup = (code: string) => {
		return this.post<RoomLookup>('/join/lookup', { code: code });
	};

	join = (request: JoinRequest) => {
		return this.post<JoinedRoom>('/join', request);
	};
}

// Calls made as a device: the device token is exchanged for short-lived tokens, kept in memory.
// The GM routes need a device on the GM seat.
export class SyncSteelDeviceApi {
	private host: string;
	private deviceToken: string;
	private http: AxiosInstance;
	private accessToken: string | null = null;
	private refreshToken: string | null = null;

	constructor(host: string, deviceToken: string) {
		this.host = trimHost(host);
		this.deviceToken = deviceToken;
		this.http = axios.create({ baseURL: this.host });
	}

	private async connect() {
		const response = await this.http.post<{ access_token: string, refresh_token: string }>('/connect', null, {
			headers: { Authorization: `Bearer ${this.deviceToken}` }
		});
		this.accessToken = response.data.access_token;
		this.refreshToken = response.data.refresh_token;
	}

	private async renew() {
		if (this.refreshToken) {
			try {
				const response = await this.http.post<{ access_token: string }>('/refresh', null, {
					headers: { Authorization: `Bearer ${this.refreshToken}` }
				});
				this.accessToken = response.data.access_token;
				return;
			} catch {
				// Fall back to the device token
			}
		}
		await this.connect();
	}

	private async request<T>(config: AxiosRequestConfig) {
		try {
			if (!this.accessToken) {
				await this.connect();
			}
			const send = () => this.http.request<T>({ ...config, headers: { ...config.headers, Authorization: `Bearer ${this.accessToken}` } });
			try {
				return await send();
			} catch (error) {
				// An expired access token gets 401; anything else is a real answer
				if (axios.isAxiosError(error) && (error.response?.status === 401)) {
					await this.renew();
					return await send();
				}
				throw error;
			}
		} catch (error) {
			throw describeError(error);
		}
	}

	me = async () => (await this.request<Me>({ method: 'GET', url: '/me' })).data;

	gmRoom = async () => (await this.request<GmRoom>({ method: 'GET', url: '/gm/room' })).data;

	rotateJoinCode = async () => (await this.request<{ joinCode: string }>({ method: 'POST', url: '/gm/join-code' })).data.joinCode;

	renameSeat = async (seatId: string, name: string) => {
		return (await this.request<SeatSummary>({ method: 'PATCH', url: `/gm/seats/${encodeURIComponent(seatId)}`, data: { name: name } })).data;
	};

	revokeDevice = async (deviceId: string) => {
		await this.request<void>({ method: 'DELETE', url: `/gm/devices/${encodeURIComponent(deviceId)}` });
	};

	exportRoom = async (): Promise<ExportFile> => {
		const response = await this.request<ArrayBuffer>({ method: 'GET', url: '/gm/export', responseType: 'arraybuffer' });
		return { filename: filenameFrom(response.headers['content-disposition'], 'sync-steel-export.json.gz'), bytes: response.data };
	};

	listSnapshots = async () => (await this.request<{ data: { date: string }[] }>({ method: 'GET', url: '/gm/snapshots' })).data.data.map(s => s.date);

	exportSnapshot = async (date: string): Promise<ExportFile> => {
		const response = await this.request<ArrayBuffer>({ method: 'GET', url: `/gm/snapshots/${encodeURIComponent(date)}/export`, responseType: 'arraybuffer' });
		return { filename: filenameFrom(response.headers['content-disposition'], `sync-steel-${date}-snapshot.json.gz`), bytes: response.data };
	};

	importRoom = async (bytes: ArrayBuffer, dryRun: boolean) => {
		const response = await this.request<{ dryRun: boolean, summary: ImportSummary }>({
			method: 'POST',
			url: `/gm/import${dryRun ? '?dryRun=1' : ''}`,
			data: bytes,
			headers: { 'Content-Type': 'application/octet-stream' }
		});
		return response.data.summary;
	};
}
