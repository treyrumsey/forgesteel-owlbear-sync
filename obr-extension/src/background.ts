import { BADGE_KEY, CONDITIONS_KEY, CONDITIONS_MENU_ID, LINK_KEY, LINK_MENU_ID, LOCAL_CHANNEL, PICKER_MODAL_ID, ROOM_KEY, UNLINK_MENU_ID } from './keys.ts';
import { type Connection, readBinding } from './connection.ts';
import { EditQueue, type PatchedTo, type RecentWrite, effectiveRev, forwarderFor, planForward } from './forwarding.ts';
import type { HeroSummary, SummaryCondition } from './summary.ts';
import { HubClient, type HubStatus, type PatchAnswer } from './hub-client.ts';
import { LABEL_STYLE, type NewLabel, isEmptyPlan, labelId, planLabels, readTag } from './labels.ts';
import type { LocalMessage, Status } from './messages.ts';
import OBR, { type Item, buildLabel, isLabel } from '@owlbear-rodeo/sdk';
import { type PartyMember, electWriter } from './election.ts';
import { type TokenLink, readLink } from './links.ts';
import { type TokenWrite, TokenWriter, type WriteOutcome } from './writer.ts';
import { applyTokenUpdate, clobberedFields, planTokenUpdate, syncedValues } from './token-update.ts';
import { conditionToken, planApply, readOwnConditions } from './condition-ops.ts';

// Runs on every Owlbear client in the room, with no popover open (manifest background_url). It:
// - follows the room's binding (ROOM_KEY in room metadata, set from the popover by the GM);
// - keeps a connection to the api's hub, with every hero's summary;
// - on the elected writer only, writes each linked token's Draw Steel Tools stats and link (writer.ts);
// - on the elected writer only, keeps each linked token's condition labels: shared Owlbear labels in
//   token-labels' stack (labels.ts), which every client sees;
// - gives the GM the Link to hero and Unlink token menus;
// - (Phase 5) sends edits made on a linked token to the api: on the editing player's own client only
//   (forwarding.ts), one patch per token at a time, holding the writer off that token until it's answered;
// - gives everyone a Conditions panel in the token menu (conditions-embed.ts), for any selection of tokens, linked
//   or not. It and the popover's Conditions tab ask this page to make the change: a patch to each linked hero,
//   and a write of CONDITIONS_KEY on each other token;
// - on the elected writer only, keeps the condition labels of tokens with conditions of their own, too.

const VERIFY_MS = 1500;
// After the scene opens, a change to a token is a restore (Party Continuity), not an edit (report §4.7.2)
const SETTLE_MS = 2000;
// The longest the writer leaves a token alone while its patch is out
const HOLD_MS = 10_000;
const HUB_CHECK_MS = 60_000;
// The Conditions panel's height in the token menu, in pixels (conditions-embed.html)
const CONDITIONS_EMBED_HEIGHT = 136;

// The background page has no UI: its log is the GM's way to see what the writer did (the browser console)
// eslint-disable-next-line no-console
const log = (line: string) => console.info(`[Sync Steel] ${line}`);

const asset = (name: string) => `${import.meta.env.BASE_URL}${name}`;

let binding: Connection | null = null;
let hub: HubClient | null = null;
let hubStatus: HubStatus = 'off';
let hubDetail = '';
let synced = false;

let self: PartyMember = { connectionId: '', role: 'PLAYER', name: '', playerId: '' };
let party: PartyMember[] = [];
let writer: TokenWriter | null = null;

let sceneReady = false;
// Linked tokens in the open scene, and what this client last saw and wrote on each
const tokens = new Map<string, { name: string, link: TokenLink, visible: boolean, seen: string }>();
const lastWritten = new Map<string, string>();
// This client's writes in the last moment (for spotting DST clobbers), patches out and what they did
const recentWrites = new Map<string, RecentWrite>();
const holds = new Map<string, { editId: string, heroId: string, fromRev: number, waitRev: number | null, timer: ReturnType<typeof setTimeout> }>();
const patchedTo = new Map<string, PatchedTo>();
// Unlinked tokens with conditions of their own (CONDITIONS_KEY) in the open scene
const owned = new Map<string, { conditions: SummaryCondition[], visible: boolean }>();
// Condition patches out, by edit id: what to do with the server's answer (null: none came)
const conditionEdits = new Map<string, (answer: PatchAnswer | null) => void>();
let settleUntil = 0;
let orphanTimer: ReturnType<typeof setTimeout> | null = null;

const isRateLimit = (error: unknown) => (typeof error === 'object') && (error !== null) && ((error as { name?: unknown }).name === 'RateLimitHit');

// What a token shows, for spotting changes made by anyone else
const tokenSignature = (metadata: Record<string, unknown>) => JSON.stringify([ syncedValues(metadata), metadata[LINK_KEY] ?? null ]);

// #region Status for the popover and the hero picker

const writerMember = () => electWriter([ self, ...party ]);

const status = (): Status => {
	const elected = writerMember();
	return {
		bound: binding !== null,
		api: binding?.api ?? '',
		roomName: hub?.roomName ?? '',
		hub: hubStatus,
		hubDetail: hubDetail,
		writerName: elected ? (elected.connectionId === self.connectionId ? `${elected.name} (this client)` : elected.name) : '',
		isWriter: writer !== null,
		sceneReady: sceneReady,
		linked: [ ...tokens.entries() ].map(([ id, token ]) => {
			const summary = hub?.get(token.link.heroId) ?? null;
			return {
				tokenId: id,
				tokenName: token.name,
				heroName: summary ? `${summary.name} (${summary.seatName})` : 'unknown hero',
				stats: summary ? `${summary.stamina}/${summary.staminaMax} stamina` : '',
				current: summary !== null && token.link.syncedRev === summary.rev
			};
		})
	};
};

const sendLocal = (message: LocalMessage) => {
	OBR.broadcast.sendMessage(LOCAL_CHANNEL, message, { destination: 'LOCAL' }).catch(() => undefined);
};

let statusTimer: ReturnType<typeof setTimeout> | null = null;
const announce = () => {
	if (statusTimer === null) {
		statusTimer = setTimeout(() => {
			statusTimer = null;
			sendLocal({ type: 'status', status: status() });
		}, 100);
	}
};

// #endregion

// #region Writing tokens (the elected writer only)

const verify = (checks: { tokenId: string, before: ReturnType<typeof syncedValues>, written: ReturnType<typeof syncedValues>, summary: HeroSummary }[]) => {
	setTimeout(async () => {
		if (!writer || !sceneReady) {
			return;
		}
		const items = await OBR.scene.items.getItems(checks.map(check => check.tokenId));
		checks.forEach(check => {
			const item = items.find(i => i.id === check.tokenId);
			if (!item) {
				return;
			}
			const clobbered = clobberedFields(check.before, check.written, syncedValues(item.metadata));
			if (clobbered.length > 0) {
				log(`${item.name}: ${clobbered.join(', ')} went back to the old value just after the write; writing again`);
				writer?.want(item.id, hub?.get(check.summary.heroId) ?? check.summary);
			}
		});
	}, VERIFY_MS);
};

const writeBatch = async (batch: TokenWrite[]): Promise<WriteOutcome> => {
	if (!sceneReady) {
		return { ok: true };
	}
	const wanted = new Map(batch.map(write => [ write.tokenId, write.summary ]));
	const checks: Parameters<typeof verify>[0] = [];
	// Each token's conditions, for its labels: none once it's no longer linked to this hero
	const labelTargets = new Map<string, SummaryCondition[]>();
	try {
		// The filter form re-reads each token, so the diff is against its current data (report §4.8)
		await OBR.scene.items.updateItems(item => wanted.has(item.id), drafts => {
			drafts.forEach(draft => {
				const summary = wanted.get(draft.id)!;
				const metadata = draft.metadata as Record<string, unknown>;
				if (holds.has(draft.id)) {
					// Its edit is on the way to the server; the answer brings the values to write
					return;
				}
				labelTargets.set(draft.id, readLink(metadata)?.heroId === summary.heroId ? summary.conditions : []);
				const plan = planTokenUpdate(metadata, summary);
				if (plan.kind === 'skip') {
					log(`Not writing ${draft.name}: ${plan.reason}`);
					return;
				}
				if (plan.kind === 'unchanged') {
					return;
				}
				const before = syncedValues(metadata);
				applyTokenUpdate(metadata, plan);
				const written = syncedValues(metadata);
				lastWritten.set(draft.id, tokenSignature(metadata));
				recentWrites.set(draft.id, { before: before, written: written, at: Date.now() });
				checks.push({ tokenId: draft.id, before: before, written: written, summary: summary });
			});
		});
	} catch (error) {
		return { ok: false, rateLimited: isRateLimit(error), error: error };
	}
	if (checks.length > 0) {
		verify(checks);
	}
	try {
		await syncLabels(labelTargets);
	} catch (error) {
		return { ok: false, rateLimited: isRateLimit(error), error: error };
	}
	return { ok: true };
};

const buildConditionLabel = (label: NewLabel, dpi: number, visible: boolean) => buildLabel()
	.id(label.id)
	.name('Condition')
	.plainText(label.text)
	.position(label.position)
	.attachedTo(label.tokenId)
	// Like token-labels: follows the token's position only. Visibility follows it too, so a hidden token's
	// labels are hidden from players.
	.disableAttachmentBehavior([ 'ROTATION', 'SCALE', 'COPY' ])
	.visible(visible)
	.layer('TEXT')
	.locked(false)
	.disableHit(false)
	.fontFamily(LABEL_STYLE.fontFamily)
	.fontSize(LABEL_STYLE.fontSize)
	.fontWeight(LABEL_STYLE.fontWeight)
	.fillOpacity(LABEL_STYLE.fillOpacity)
	.backgroundOpacity(LABEL_STYLE.backgroundOpacity)
	.cornerRadius(LABEL_STYLE.cornerRadius(dpi))
	.padding(LABEL_STYLE.padding(dpi))
	.pointerHeight(0)
	.minViewScale(1)
	.maxViewScale(1)
	.metadata({ [BADGE_KEY]: { tokenId: label.tokenId, conditionId: label.conditionId } })
	.build();

// Brings each token's condition labels in line with its conditions (labels.ts): at most one add, one delete
// and one update call for the whole batch. Throws, like the token write, on a rate limit.
const syncLabels = async (targets: Map<string, SummaryCondition[]>) => {
	if (targets.size === 0) {
		return;
	}
	const ids = [ ...targets.keys() ];
	const [ dpi, bounds, attached ] = await Promise.all([
		OBR.scene.grid.getDpi(),
		Promise.all(ids.map(id => OBR.scene.items.getItemBounds([ id ]).catch(() => null))),
		OBR.scene.items.getItems(item => (item.attachedTo !== undefined) && targets.has(item.attachedTo) && isLabel(item))
	]);
	const add: Item[] = [];
	const remove: string[] = [];
	const update = new Map<string, { text?: string, position?: { x: number, y: number } }>();
	ids.forEach((tokenId, index) => {
		const box = bounds[index];
		if (!box) {
			return;
		}
		const existing = attached
			.filter(item => (item.attachedTo === tokenId) && isLabel(item))
			.map(item => ({ id: item.id, text: isLabel(item) ? item.text.plainText : '', position: item.position, tag: readTag(item.metadata[BADGE_KEY]) }));
		const plan = planLabels(tokenId, box.min, targets.get(tokenId)!, existing);
		if (isEmptyPlan(plan)) {
			return;
		}
		const visible = tokens.get(tokenId)?.visible ?? owned.get(tokenId)?.visible ?? true;
		plan.add.forEach(label => add.push(buildConditionLabel(label, dpi, visible)));
		remove.push(...plan.delete);
		plan.update.forEach(change => update.set(change.id, change));
	});
	if (remove.length > 0) {
		await OBR.scene.items.deleteItems(remove);
	}
	if (add.length > 0) {
		await OBR.scene.items.addItems(add);
	}
	if (update.size > 0) {
		await OBR.scene.items.updateItems([ ...update.keys() ], drafts => {
			drafts.forEach(draft => {
				const change = update.get(draft.id);
				if (!change || !isLabel(draft)) {
					return;
				}
				if (change.text !== undefined) {
					draft.text.plainText = change.text;
				}
				if (change.position) {
					draft.position = change.position;
				}
			});
		});
	}
	if ((remove.length + add.length + update.size) > 0) {
		log(`Condition labels: ${add.length} added, ${remove.length} removed, ${update.size} updated`);
	}
};

// Labels for tokens with conditions of their own: brought in line just after a change, by the writer only
const ownDirty = new Set<string>();
let ownTimer: ReturnType<typeof setTimeout> | null = null;
const syncOwnLabels = (delay = 150) => {
	if (ownTimer !== null) {
		return;
	}
	ownTimer = setTimeout(async () => {
		ownTimer = null;
		if (!writer || !sceneReady || (ownDirty.size === 0)) {
			return;
		}
		const targets = new Map([ ...ownDirty ].filter(id => owned.has(id)).map(id => [ id, owned.get(id)!.conditions ]));
		ownDirty.clear();
		try {
			await syncLabels(targets);
		} catch (error) {
			targets.forEach((_, id) => ownDirty.add(id));
			log(`Couldn't update condition labels${isRateLimit(error) ? ' (rate limited)' : ''}: ${String(error)}`);
			syncOwnLabels(1000);
		}
	}, delay);
};

// The writer: marks each token with conditions of its own whose labels of ours don't match them (a condition
// added or removed, or a label deleted by hand, which comes back)
const checkOwnLabels = (items: Item[]) => {
	const ours = new Map<string, Set<string>>();
	items.forEach(item => {
		const tag = readTag(item.metadata[BADGE_KEY]);
		if (tag) {
			ours.set(tag.tokenId, (ours.get(tag.tokenId) ?? new Set()).add(tag.conditionId));
		}
	});
	owned.forEach((own, tokenId) => {
		const have = ours.get(tokenId) ?? new Set<string>();
		const want = new Set(own.conditions.map(c => c.id));
		if ((want.size !== have.size) || [ ...want ].some(id => !have.has(id))) {
			ownDirty.add(tokenId);
		}
	});
	if (ownDirty.size > 0) {
		syncOwnLabels();
	}
};

// Our labels whose token no longer has conditions: unlinked, its own all gone, or its condition gone and the
// token no longer in a batch
const removeOrphanLabels = () => {
	if (orphanTimer !== null) {
		return;
	}
	orphanTimer = setTimeout(async () => {
		orphanTimer = null;
		if (!writer || !sceneReady) {
			return;
		}
		const orphans = await OBR.scene.items.getItems(item => {
			const tag = readTag(item.metadata[BADGE_KEY]);
			return (tag !== null) && !tokens.has(tag.tokenId) && !owned.has(tag.tokenId);
		});
		if (orphans.length > 0) {
			await OBR.scene.items.deleteItems(orphans.map(item => item.id)).catch(error => log(`Couldn't remove condition labels: ${String(error)}`));
		}
	}, 500);
};

const wantToken = (tokenId: string) => {
	const token = tokens.get(tokenId);
	const summary = token ? hub?.get(token.link.heroId) : null;
	if (writer && summary && !holds.has(tokenId)) {
		writer.want(tokenId, summary);
	}
};

// Writes every linked token that doesn't already show its hero's latest summary
const reconcile = async () => {
	if (!writer || !sceneReady || !hub) {
		return;
	}
	(await OBR.scene.items.getItems(item => LINK_KEY in item.metadata)).forEach(wantIfStale);
};

const electionChanged = () => {
	const elected = writerMember();
	const mine = (elected !== null) && (elected.connectionId === self.connectionId) && (binding !== null);
	if (mine && !writer) {
		log('This client is now the writer');
		writer = new TokenWriter({
			now: () => Date.now(),
			setTimer: (callback, ms) => setTimeout(callback, ms),
			clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
			write: writeBatch,
			log: log
		});
		writer.settle();
		reconcile();
		if (sceneReady) {
			OBR.scene.items.getItems().then(checkOwnLabels).catch(() => undefined);
		}
	} else if (!mine && writer) {
		log('Another client is now the writer');
		writer.stop();
		writer = null;
	}
	announce();
};

// #endregion

// #region The hub

const onSummary = (summary: HeroSummary) => {
	holds.forEach((hold, tokenId) => {
		if ((hold.heroId === summary.heroId) && (hold.waitRev !== null) && (summary.rev >= hold.waitRev)) {
			releaseHold(tokenId, true);
		}
	});
	tokens.forEach((token, tokenId) => {
		if (token.link.heroId === summary.heroId) {
			wantToken(tokenId);
		}
	});
	announce();
};

const connectHub = (next: Connection | null) => {
	if ((next?.api === binding?.api) && (next?.token === binding?.token)) {
		return;
	}
	hub?.stop();
	hub = null;
	synced = false;
	[ ...holds.keys() ].forEach(tokenId => releaseHold(tokenId, false));
	binding = next;
	if (binding) {
		hub = new HubClient({
			connection: binding,
			onSummary: onSummary,
			onDeleted: () => announce(),
			onAnswer: onAnswer,
			onSynced: () => {
				synced = true;
				reconcile();
				announce();
				sendLocal({ type: 'heroes', heroes: hub?.all() ?? [], synced: true });
			},
			onStatus: (next, detail) => {
				hubStatus = next;
				hubDetail = detail ?? '';
				if (next !== 'live') {
					synced = false;
				}
				announce();
			}
		});
		hub.start();
	} else {
		hubStatus = 'off';
		hubDetail = '';
	}
	electionChanged();
};

// #endregion

// #region Token edits → Forge Steel (Phase 5)

const REJECTIONS: Record<string, string> = {
	'base-gone': 'the hero has changed a lot in Forge Steel since this token was updated',
	'invalid': 'Forge Steel can\'t hold that value',
	'unknown-hero': 'the hero is no longer in the Sync Steel room',
	'rate-limited': 'too many edits at once; try again in a moment',
	'disconnected': 'the connection to Sync Steel dropped; check the hero in Forge Steel'
};

// The token's patch was answered (applied: true) or given up on. Either way the writer may write it again.
const releaseHold = (tokenId: string, applied: boolean) => {
	const hold = holds.get(tokenId);
	if (!hold) {
		return;
	}
	clearTimeout(hold.timer);
	holds.delete(tokenId);
	const summary = hub?.get(hold.heroId);
	if (applied && summary) {
		patchedTo.set(tokenId, { fromRev: hold.fromRev, toRev: summary.rev });
	}
	if (applied && edits.has(tokenId)) {
		// Edited again meanwhile: send that, against the new summary, before the writer touches it
		edits.release(tokenId);
		return;
	}
	edits.forget(tokenId);
	wantToken(tokenId);
};

const onAnswer = (answer: PatchAnswer) => {
	const answered = conditionEdits.get(answer.editId);
	if (answered !== undefined) {
		answered(answer);
		return;
	}
	const tokenId = [ ...holds.entries() ].find(([ , hold ]) => hold.editId === answer.editId)?.[0];
	const hold = tokenId ? holds.get(tokenId) : undefined;
	if (!tokenId || !hold) {
		return;
	}
	const name = tokens.get(tokenId)?.name ?? 'A token';
	if (answer.type === 'reject') {
		log(`${name}: the edit wasn't saved (${answer.reason})`);
		if (answer.reason !== 'disconnected') {
			OBR.notification.show(`${name}: edit not saved in Forge Steel, because ${REJECTIONS[answer.reason] ?? answer.reason}.`, 'WARNING').catch(() => undefined);
		}
		releaseHold(tokenId, false);
		return;
	}
	log(`${name}: saved in Forge Steel as rev ${answer.rev}`);
	hold.waitRev = answer.summaryRev;
	if ((hub?.get(hold.heroId)?.rev ?? 0) >= answer.summaryRev) {
		releaseHold(tokenId, true);
	}
};

// Sends what's changed on the token since the summary it shows. False while an earlier patch is still out.
const forwardToken = async (tokenId: string) => {
	if (holds.has(tokenId)) {
		return false;
	}
	if (!hub || !sceneReady) {
		return true;
	}
	const [ item ] = await OBR.scene.items.getItems([ tokenId ]);
	const link = item ? readLink(item.metadata) : null;
	if (!item || !link) {
		return true;
	}
	if (holds.has(tokenId)) {
		return false;
	}
	const plan = planForward({
		tokenId: tokenId,
		metadata: item.metadata,
		link: link,
		lastModified: item.lastModified,
		summary: hub.get(link.heroId),
		patched: patchedTo.get(tokenId),
		recentWrite: recentWrites.get(tokenId),
		verifyMs: VERIFY_MS,
		now: Date.now()
	});
	if (plan.kind === 'stale') {
		wantIfStale(item);
		return true;
	}
	if (plan.kind === 'none') {
		wantToken(tokenId);
		return true;
	}
	holds.set(tokenId, {
		editId: plan.patch.editId,
		heroId: link.heroId,
		fromRev: link.syncedRev,
		waitRev: null,
		timer: setTimeout(() => releaseHold(tokenId, false), HOLD_MS)
	});
	writer?.forget(tokenId);
	log(`${item.name}: sending ${plan.fields.map(field => `${field} ${String(plan.patch.values?.[field])}`).join(', ')} to Forge Steel`);
	hub.patch(plan.patch);
	return true;
};

const edits = new EditQueue({
	now: () => Date.now(),
	setTimer: (callback, ms) => setTimeout(callback, ms),
	clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
	send: forwardToken
});

// A change from the Conditions menu or popover tab (condition-ops.ts): a patch to each linked hero, against its
// latest summary (conditions merge by id), and one write for the tokens with conditions of their own. Answers
// once all are done.
const applyConditions = async (message: Extract<LocalMessage, { type: 'conditions.apply' }>) => {
	const failures: { tokenId: string, reason: string }[] = [];
	const done = () => {
		sendLocal({ type: 'conditions.done', requestId: message.requestId, ok: failures.length === 0, reason: failures[0]?.reason ?? '', failures: failures });
	};
	const items = sceneReady ? await OBR.scene.items.getItems(message.tokenIds) : [];
	const plan = planApply(message.op, items.map(conditionToken), () => crypto.randomUUID());
	if (!plan.ok) {
		failures.push(...message.tokenIds.map(tokenId => ({ tokenId: tokenId, reason: plan.problem })));
		done();
		return;
	}

	const own = new Map(plan.ownWrites.map(write => [ write.tokenId, write.conditions ]));
	const writing = (own.size === 0)
		? Promise.resolve()
		: OBR.scene.items.updateItems([ ...own.keys() ], drafts => {
			drafts.forEach(draft => {
				const conditions = own.get(draft.id) ?? [];
				if (conditions.length > 0) {
					draft.metadata[CONDITIONS_KEY] = conditions;
				} else {
					delete draft.metadata[CONDITIONS_KEY];
				}
			});
		}).catch(error => {
			const reason = isRateLimit(error) ? 'too many changes at once; try again in a moment' : `the token couldn't be changed (${String(error)})`;
			own.forEach((_, tokenId) => failures.push({ tokenId: tokenId, reason: reason }));
		});

	const patching = plan.heroPatches.map((patch, index) => new Promise<void>(resolve => {
		const summary = hub?.get(patch.heroId);
		if (!hub || !summary) {
			patch.tokenIds.forEach(tokenId => failures.push({ tokenId: tokenId, reason: 'Sync Steel isn\'t connected' }));
			resolve();
			return;
		}
		const editId = `${patch.tokenIds[0]}:conditions:${message.requestId}:${index}`;
		const timer = setTimeout(() => conditionEdits.get(editId)?.(null), HOLD_MS);
		conditionEdits.set(editId, answer => {
			clearTimeout(timer);
			conditionEdits.delete(editId);
			if (!answer || (answer.type === 'reject')) {
				const reason = answer ? (REJECTIONS[answer.reason] ?? `the server said ${answer.reason}`) : 'Sync Steel didn\'t answer';
				patch.tokenIds.forEach(tokenId => failures.push({ tokenId: tokenId, reason: reason }));
			}
			resolve();
		});
		hub.patch({ heroId: summary.heroId, baseRev: summary.rev, editId: editId, conditions: { add: patch.add, remove: patch.remove } });
	}));

	await Promise.all([ writing, ...patching ]);
	done();
};

// #endregion

// #region Scene: linked tokens and their labels

// Wants a token only if it doesn't already show its hero's latest summary
const wantIfStale = (item: Item) => {
	const link = readLink(item.metadata);
	const summary = link ? hub?.get(link.heroId) : null;
	if (writer && summary && !holds.has(item.id) && (planTokenUpdate(item.metadata, summary).kind === 'write')) {
		writer.want(item.id, summary);
	}
};

const itemsChanged = (items: Item[]) => {
	const arrived: Item[] = [];
	const present = new Set<string>();
	const ids = new Set(items.map(item => item.id));
	let orphaned = false;
	owned.clear();
	items.forEach(item => {
		const link = readLink(item.metadata);
		if (!link) {
			const own = readOwnConditions(item.metadata[CONDITIONS_KEY]);
			if (own.length > 0) {
				owned.set(item.id, { conditions: own, visible: item.visible });
			}
			return;
		}
		present.add(item.id);
		const signature = tokenSignature(item.metadata);
		const known = tokens.get(item.id);
		tokens.set(item.id, { name: item.name, link: link, visible: item.visible, seen: signature });
		if (!known || (known.link.heroId !== link.heroId)) {
			// Newly linked, or new in this scene (such as a Party Continuity copy)
			arrived.push(item);
			return;
		}
		if ((known.seen !== signature) && (lastWritten.get(item.id) !== signature)) {
			// Someone else changed it: give them a quiet window
			writer?.touch(item.id);
			const summary = hub?.get(link.heroId);
			if (summary && (effectiveRev(link, patchedTo.get(item.id)) !== summary.rev)) {
				// A restore (Party Continuity) or a stale copy: the token shows an older revision than the server's
				if (!holds.has(item.id)) {
					writer?.want(item.id, summary);
				}
			} else if (Date.now() < settleUntil) {
				// Just after the scene opened: a restore, so put the server's values back
				wantIfStale(item);
			} else if (forwarderFor(item.lastModifiedUserId, [ self, ...party ], writerMember()) === self.connectionId) {
				// An edit, and this client sends it (report §4.7)
				edits.schedule(item.id);
			}
		}
	});
	[ ...tokens.keys() ].filter(id => !present.has(id)).forEach(id => {
		tokens.delete(id);
		lastWritten.delete(id);
		recentWrites.delete(id);
		patchedTo.delete(id);
		edits.forget(id);
		writer?.forget(id);
	});
	if (writer) {
		items.forEach(item => {
			const tag = readTag(item.metadata[BADGE_KEY]);
			if (tag && !tokens.has(tag.tokenId) && !owned.has(tag.tokenId)) {
				orphaned = true;
			}
		});
		checkOwnLabels(items);
		// A label of ours missing (deleted by hand, or not made yet): the writer puts it back (decisions.md)
		tokens.forEach((token, tokenId) => {
			if (token.link.conditions.some(c => !ids.has(labelId(tokenId, c.id)))) {
				wantToken(tokenId);
			}
		});
	}
	if (orphaned) {
		removeOrphanLabels();
	}
	if (arrived.length > 0) {
		settleUntil = Date.now() + SETTLE_MS;
	}
	if ((arrived.length > 0) && writer) {
		// Let the scene settle, then bring the new tokens up to date (report §4.8)
		writer.settle();
		arrived.forEach(wantIfStale);
	}
	announce();
};

const sceneReadyChanged = async (ready: boolean) => {
	sceneReady = ready;
	tokens.clear();
	owned.clear();
	ownDirty.clear();
	lastWritten.clear();
	recentWrites.clear();
	patchedTo.clear();
	if (ready) {
		settleUntil = Date.now() + SETTLE_MS;
		itemsChanged(await OBR.scene.items.getItems());
		// Before 27 Nov 2026 each client drew its own badges as local items: clear any left over
		const old = await OBR.scene.local.getItems(item => BADGE_KEY in item.metadata);
		if (old.length > 0) {
			await OBR.scene.local.deleteItems(old.map(item => item.id));
		}
	}
	announce();
};

// #endregion

// #region Context menus

const createMenus = async () => {
	await OBR.contextMenu.create({
		id: LINK_MENU_ID,
		icons: [ {
			icon: asset('link.svg'),
			label: 'Link to hero',
			// Only unlinked tokens; to relink, Unlink first
			filter: { roles: [ 'GM' ], max: 1, every: [ { key: 'layer', value: 'CHARACTER' }, { key: [ 'metadata', LINK_KEY ], value: undefined } ] }
		} ],
		onClick: context => {
			const token = context.items[0];
			if (token) {
				OBR.modal.open({ id: PICKER_MODAL_ID, url: `${asset('picker.html')}?token=${encodeURIComponent(token.id)}`, width: 380, height: 520 });
			}
		}
	});
	await OBR.contextMenu.create({
		id: UNLINK_MENU_ID,
		icons: [ {
			icon: asset('unlink.svg'),
			label: 'Unlink from hero',
			filter: {
				roles: [ 'GM' ],
				every: [ { key: 'layer', value: 'CHARACTER' }, { key: [ 'metadata', LINK_KEY ], value: undefined, operator: '!=' } ]
			}
		} ],
		onClick: context => {
			// The token keeps the stats it shows; it just stops following the hero. Its condition labels go
			// (ours only: token-labels' own stay).
			const unlinked = new Set(context.items.map(item => item.id));
			context.items.forEach(item => {
				edits.forget(item.id);
				releaseHold(item.id, false);
			});
			OBR.scene.items.updateItems([ ...unlinked ], drafts => {
				drafts.forEach(draft => {
					delete draft.metadata[LINK_KEY];
				});
			});
			// (A token with conditions of its own keeps their labels; linking clears those, so it shouldn't have any)
			const bare = new Set(context.items.filter(item => !(CONDITIONS_KEY in item.metadata)).map(item => item.id));
			OBR.scene.items.getItems(item => bare.has(readTag(item.metadata[BADGE_KEY])?.tokenId ?? ''))
				.then(labels => (labels.length > 0 ? OBR.scene.items.deleteItems(labels.map(label => label.id)) : undefined))
				.catch(error => log(`Couldn't remove condition labels: ${String(error)}`));
		}
	});
	await createConditionsMenu((await OBR.theme.getTheme()).mode);
	OBR.theme.onChange(theme => {
		createConditionsMenu(theme.mode).catch(() => undefined);
	});
};

// Everyone: the Conditions panel, in the menu of any selection of characters, linked or not. Its height is
// fixed (Owlbear can't resize an embed as it opens): CONDITIONS_EMBED_HEIGHT fits its two rows of controls and
// three of chips. The theme goes in the address so it opens in the right colours (theme.ts).
const createConditionsMenu = (mode: 'DARK' | 'LIGHT') => OBR.contextMenu.create({
	id: CONDITIONS_MENU_ID,
	icons: [ {
		icon: asset('conditions.svg'),
		label: 'Conditions',
		filter: { every: [ { key: 'layer', value: 'CHARACTER' } ] }
	} ],
	embed: { url: `${asset('conditions-embed.html')}?themeMode=${mode}`, height: CONDITIONS_EMBED_HEIGHT }
});

// #endregion

OBR.onReady(async () => {
	const [ connectionId, role, name, playerId ] = await Promise.all([ OBR.player.getConnectionId(), OBR.player.getRole(), OBR.player.getName(), OBR.player.getId() ]);
	self = { connectionId: connectionId, role: role, name: name, playerId: playerId };
	const toMember = (player: { id: string, connectionId: string, role: 'GM' | 'PLAYER', name: string }): PartyMember => ({ connectionId: player.connectionId, role: player.role, name: player.name, playerId: player.id });
	party = (await OBR.party.getPlayers()).map(toMember);

	OBR.player.onChange(player => {
		if ((player.role !== self.role) || (player.name !== self.name)) {
			self = { ...self, role: player.role, name: player.name };
			electionChanged();
		}
	});
	OBR.party.onChange(players => {
		const next = players.map(toMember);
		// Owlbear also reports selection and view changes here; only who's present and their role matter
		const key = (members: PartyMember[]) => members.map(m => `${m.connectionId}:${m.role}`).sort().join();
		const changed = key(next) !== key(party);
		party = next;
		if (changed) {
			electionChanged();
		}
	});

	OBR.broadcast.onMessage(LOCAL_CHANNEL, event => {
		const message = event.data as LocalMessage;
		switch (message.type) {
			case 'status?':
				sendLocal({ type: 'status', status: status() });
				break;
			case 'heroes?':
				sendLocal({ type: 'heroes', heroes: hub?.all() ?? [], synced: synced });
				break;
			case 'linked':
				wantToken(message.tokenId);
				break;
			case 'conditions.apply':
				applyConditions(message).catch(error => log(`Couldn't change conditions: ${String(error)}`));
				break;
		}
	});

	connectHub(readBinding((await OBR.room.getMetadata())[ROOM_KEY]));
	OBR.room.onMetadataChange(metadata => connectHub(readBinding(metadata[ROOM_KEY])));

	OBR.scene.onReadyChange(ready => {
		sceneReadyChanged(ready);
	});
	OBR.scene.items.onChange(items => {
		if (sceneReady) {
			itemsChanged(items);
		}
	});
	await sceneReadyChanged(await OBR.scene.isReady());

	await createMenus();

	window.addEventListener('online', () => hub?.check());
	setInterval(() => hub?.check(), HUB_CHECK_MS);
	log(`Ready as ${self.name} (${self.role})`);
});
