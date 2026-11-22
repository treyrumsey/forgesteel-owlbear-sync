// Sync Steel's build-time variables, merged into Vite's ImportMetaEnv (see vite.sync-steel.config.ts)
interface ImportMetaEnv {
	readonly VITE_SYNC_STEEL_API_HOST?: string;
}
