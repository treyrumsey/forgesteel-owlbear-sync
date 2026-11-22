// The Sync Steel api's address.
//
// The branded build (vite.sync-steel.config.ts) bakes in the placeholder FORGESTEEL_SYNC_STEEL_API_HOST,
// and nginx/env.sh swaps it for the container's variable of that name when fs-web starts.
// A placeholder that was never replaced counts as unset.

export const SYNC_STEEL_DEV_API_HOST = 'http://localhost:8787';

export const resolveApiHost = (value: string | undefined) => {
	const host = (value ?? '').trim().replace(/\/+$/, '');
	if (!host || host.startsWith('FORGESTEEL_')) {
		return SYNC_STEEL_DEV_API_HOST;
	}
	return host;
};

export const getSyncSteelApiHost = () => resolveApiHost(import.meta.env.VITE_SYNC_STEEL_API_HOST);
