import { readDstToken, summaryToDstPatch } from './dst-token.ts';
import type { HeroSummary } from './summary.ts';
import type { PartyMember } from './election.ts';
import type { PatchMessage } from './hub-client.ts';
import type { TokenLink } from './links.ts';
import type { syncedValues } from './token-update.ts';

// Token edits → server (Phase 5, report §4.7 "Token edits → server", §4.8 stage 4). When someone changes a
// linked token's stats in Draw Steel Tools, one client sends the change to the api as a patch against the
// summary revision the token shows. Plain TypeScript, so it can be tested without Owlbear.

// The fields a token edit can change. The name, maximum stamina and resource name follow Forge Steel only:
// the writer puts them back.
export const EDITABLE_FIELDS = [ 'stamina', 'temporaryStamina', 'recoveries', 'surges', 'heroicResource' ] as const;

type EditableField = typeof EDITABLE_FIELDS[number];
type Values = ReturnType<typeof syncedValues>;

// Exactly one client sends each edit: the lowest connection of the player who made it (Owlbear's
// lastModifiedUserId), so a GM signed in on the laptop and the TV sends it once. If that player has left,
// the elected writer sends it.
export const forwarderFor = (userId: string, members: PartyMember[], writer: PartyMember | null) => {
	const own = members
		.filter(member => (member.playerId !== undefined) && (member.playerId === userId))
		.sort((a, b) => (a.connectionId < b.connectionId ? -1 : (a.connectionId > b.connectionId ? 1 : 0)));
	return own[0]?.connectionId ?? writer?.connectionId ?? null;
};

// What this client sent last for a token, and what the server made of it: while the token's link still says
// `fromRev` (the writer hasn't rewritten it yet), it shows `toRev`. A restored copy with an older link
// doesn't match, so it's still treated as stale.
export interface PatchedTo {
	fromRev: number;
	toRev: number;
}

export const effectiveRev = (link: TokenLink, patched: PatchedTo | undefined) => {
	return (patched && (patched.fromRev === link.syncedRev)) ? patched.toRev : link.syncedRev;
};

// This client's own write to the token, if it's recent: a field back at its value from before the write is
// Draw Steel Tools saving an older copy (spike finding 8), not an edit, and the writer puts it right.
export interface RecentWrite {
	before: Values;
	written: Values;
	at: number;
}

export interface ForwardInput {
	tokenId: string;
	metadata: Record<string, unknown>;
	link: TokenLink;
	// When Owlbear last changed the item: the same on every client, so the edit id is too
	lastModified: string;
	summary: HeroSummary | null;
	patched?: PatchedTo;
	recentWrite?: RecentWrite;
	verifyMs: number;
	now: number;
}

export type ForwardPlan =
	| { kind: 'forward', patch: PatchMessage, fields: EditableField[] }
	// The token shows an older revision than the server's latest summary: a restore or a stale copy, which
	// the writer overwrites (report §4.7.2)
	| { kind: 'stale' }
	| { kind: 'none', reason: string };

const differs = (a: unknown, b: unknown) => (typeof a === 'number') && (typeof b === 'number') ? a !== b : false;

export const planForward = (input: ForwardInput): ForwardPlan => {
	const { link, summary } = input;
	if (!summary) {
		return { kind: 'none', reason: 'no summary for the hero yet' };
	}
	if (effectiveRev(link, input.patched) !== summary.rev) {
		return { kind: 'stale' };
	}
	const read = readDstToken(input.metadata);
	if (read.kind !== 'hero') {
		return { kind: 'none', reason: 'not a Draw Steel Tools hero token' };
	}

	const shown = summaryToDstPatch(summary);
	const recent = (input.recentWrite && (input.now - input.recentWrite.at <= input.verifyMs)) ? input.recentWrite : undefined;
	const values: NonNullable<PatchMessage['values']> = {};
	const fields: EditableField[] = [];
	EDITABLE_FIELDS.forEach(field => {
		// Missing: Draw Steel Tools writes sparse data, and a field it hasn't stored isn't an edit
		const value = read.data[field];
		if ((value === undefined) || !differs(value, shown[field])) {
			return;
		}
		if ((field === 'heroicResource') && !summary.resource) {
			return;
		}
		if (recent && (recent.written[field] !== recent.before[field]) && (value === recent.before[field])) {
			return;
		}
		values[field] = value;
		fields.push(field);
	});
	if (fields.length === 0) {
		return { kind: 'none', reason: 'no edited values' };
	}
	return {
		kind: 'forward',
		patch: { heroId: summary.heroId, baseRev: summary.rev, editId: `${input.tokenId}:${input.lastModified}`, values: values },
		fields: fields
	};
};

// The per-token queue (report §4.8 stage 4): 500 ms after the last change, and at most 2 s after the first,
// so a run of clicks is one patch. `send` resolves false when the token can't be sent yet (an earlier patch
// for it is still waiting for its answer); release() sends it then.
export interface EditQueueDeps {
	now: () => number;
	setTimer: (callback: () => void, ms: number) => unknown;
	clearTimer: (timer: unknown) => void;
	send: (tokenId: string) => Promise<boolean>;
}

export interface EditQueueTiming {
	trailingMs: number;
	maxWaitMs: number;
}

export const DEFAULT_EDIT_TIMING: EditQueueTiming = { trailingMs: 500, maxWaitMs: 2000 };

export class EditQueue {
	private readonly deps: EditQueueDeps;
	private readonly timing: EditQueueTiming;
	private readonly pending = new Map<string, { firstAt: number, lastAt: number, timer: unknown }>();
	private readonly blocked = new Set<string>();
	private stopped = false;

	constructor(deps: EditQueueDeps, timing: Partial<EditQueueTiming> = {}) {
		this.deps = deps;
		this.timing = { ...DEFAULT_EDIT_TIMING, ...timing };
	}

	// The token changed
	schedule(tokenId: string) {
		if (this.stopped) {
			return;
		}
		if (this.blocked.has(tokenId)) {
			// Its earlier patch is still out; this change goes with the next one
			return;
		}
		const now = this.deps.now();
		const existing = this.pending.get(tokenId);
		if (existing) {
			this.deps.clearTimer(existing.timer);
		}
		const firstAt = existing?.firstAt ?? now;
		const due = Math.min(now + this.timing.trailingMs, firstAt + this.timing.maxWaitMs);
		const timer = this.deps.setTimer(() => this.fire(tokenId), Math.max(0, due - now));
		this.pending.set(tokenId, { firstAt: firstAt, lastAt: now, timer: timer });
	}

	// The token's earlier patch was answered: send what's changed since, if anything
	release(tokenId: string) {
		if (this.blocked.delete(tokenId)) {
			this.fire(tokenId);
		}
	}

	has(tokenId: string) {
		return this.pending.has(tokenId) || this.blocked.has(tokenId);
	}

	forget(tokenId: string) {
		const entry = this.pending.get(tokenId);
		if (entry) {
			this.deps.clearTimer(entry.timer);
		}
		this.pending.delete(tokenId);
		this.blocked.delete(tokenId);
	}

	stop() {
		this.stopped = true;
		[ ...this.pending.keys() ].forEach(tokenId => this.forget(tokenId));
		this.blocked.clear();
	}

	private fire(tokenId: string) {
		this.pending.delete(tokenId);
		if (this.stopped) {
			return;
		}
		this.deps.send(tokenId)
			.catch(() => true)
			.then(sent => {
				if (!sent && !this.stopped) {
					this.blocked.add(tokenId);
				}
			});
	}
}
