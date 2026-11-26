import type { HeroSummary } from './summary.ts';
import type { HubStatus } from './hub-client.ts';

// Broadcasts between this client's own pages, on LOCAL_CHANNEL with destination LOCAL

export interface LinkedToken {
	tokenId: string;
	tokenName: string;
	heroName: string;
	stats: string;
	// The token shows the hero's latest revision
	current: boolean;
}

export interface Status {
	bound: boolean;
	api: string;
	roomName: string;
	hub: HubStatus;
	hubDetail: string;
	writerName: string;
	isWriter: boolean;
	sceneReady: boolean;
	linked: LinkedToken[];
}

export type LocalMessage =
	| { type: 'status?' }
	| { type: 'status', status: Status }
	| { type: 'heroes?' }
	| { type: 'heroes', heroes: HeroSummary[], synced: boolean }
	| { type: 'linked', tokenId: string };
