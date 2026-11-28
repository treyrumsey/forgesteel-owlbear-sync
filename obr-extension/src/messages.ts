import type { ConditionOp } from './condition-ops.ts';
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
	| { type: 'linked', tokenId: string }
	// A change to the conditions of these tokens, from the Conditions menu or popover tab, and the background
	// page's answer once it's written (tokens of their own) and the server has answered (linked heroes)
	| { type: 'conditions.apply', requestId: string, tokenIds: string[], op: ConditionOp }
	| { type: 'conditions.done', requestId: string, ok: boolean, reason: string, failures: { tokenId: string, reason: string }[] }
	// The Conditions menu's ⋯ button: the popover opens on its Conditions tab
	| { type: 'conditions.open' };
