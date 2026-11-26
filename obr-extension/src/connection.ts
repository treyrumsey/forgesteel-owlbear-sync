// Reads the connection string the GM copies from the Sync Steel page (src/sync-steel/logic/owlbear-connection.ts)

export interface Connection {
	api: string;
	token: string;
}

const PREFIX = 'sync-steel-owlbear:';

const fromBase64Url = (text: string) => {
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
	return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
};

export const parseConnection = (text: string): Connection | null => {
	const trimmed = text.trim();
	if (!trimmed.startsWith(PREFIX)) {
		return null;
	}
	try {
		const value = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length))) as Record<string, unknown>;
		const api = typeof value.api === 'string' ? value.api.trim().replace(/\/+$/, '') : '';
		const token = typeof value.token === 'string' ? value.token : '';
		if (!/^https?:\/\/[^\s]+$/i.test(api) || !token) {
			return null;
		}
		return { api: api, token: token };
	} catch {
		return null;
	}
};

// The binding stored in room metadata under ROOM_KEY
export const readBinding = (value: unknown): Connection | null => {
	if ((typeof value !== 'object') || (value === null)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if ((typeof record.api !== 'string') || (typeof record.token !== 'string') || !record.api || !record.token) {
		return null;
	}
	return { api: record.api, token: record.token };
};
