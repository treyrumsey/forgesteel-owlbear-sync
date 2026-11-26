import { BADGE_KEY, LINK_KEY, LINK_MENU_ID, LOCAL_CHANNEL, PICKER_MODAL_ID, ROOM_KEY, UNLINK_MENU_ID } from './keys.ts';
import { type Badge, badgeSignature, layoutBadges } from './badges.ts';
import { type Connection, readBinding } from './connection.ts';
import { HubClient, type HubStatus } from './hub-client.ts';
import type { LocalMessage, Status } from './messages.ts';
import OBR, { type Item, buildLabel } from '@owlbear-rodeo/sdk';
import { type PartyMember, electWriter } from './election.ts';
import { type TokenLink, readLink } from './links.ts';
import { type TokenWrite, TokenWriter, type WriteOutcome } from './writer.ts';
import { applyTokenUpdate, clobberedFields, planTokenUpdate, syncedValues } from './token-update.ts';
import type { HeroSummary } from './summary.ts';

// Runs on every Owlbear client in the room, with no popover open (manifest background_url). It:
// - follows the room's binding (ROOM_KEY in room metadata, set from the popover by the GM);
// - keeps a connection to the api's hub, with every hero's summary;
// - on the elected writer only, writes each linked token's Draw Steel Tools stats and link (writer.ts);
// - on every client, draws condition badges as local items;
// - gives the GM the Link to hero and Unlink token menus.

const VERIFY_MS = 1500;
const BADGE_DEBOUNCE_MS = 200;
const HUB_CHECK_MS = 60_000;

// The background page has no UI: its log is the GM's way to see what the writer did (the browser console)
// eslint-disable-next-line no-console
const log = (line: string) => console.info(`[Sync Steel] ${line}`);

const asset = (name: string) => `${import.meta.env.BASE_URL}${name}`;

let binding: Connection | null = null;
let hub: HubClient | null = null;
let hubStatus: HubStatus = 'off';
let hubDetail = '';
let synced = false;

let self: PartyMember = { connectionId: '', role: 'PLAYER', name: '' };
let party: PartyMember[] = [];
let writer: TokenWriter | null = null;

let sceneReady = false;
// Linked tokens in the open scene, and what this client last saw and wrote on each
const tokens = new Map<string, { name: string, link: TokenLink, visible: boolean, seen: string }>();
const lastWritten = new Map<string, string>();
let badgeTimer: ReturnType<typeof setTimeout> | null = null;

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
	try {
		// The filter form re-reads each token, so the diff is against its current data (report §4.8)
		await OBR.scene.items.updateItems(item => wanted.has(item.id), drafts => {
			drafts.forEach(draft => {
				const summary = wanted.get(draft.id)!;
				const metadata = draft.metadata as Record<string, unknown>;
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
				checks.push({ tokenId: draft.id, before: before, written: written, summary: summary });
			});
		});
	} catch (error) {
		return { ok: false, rateLimited: isRateLimit(error), error: error };
	}
	if (checks.length > 0) {
		verify(checks);
	}
	return { ok: true };
};

const wantToken = (tokenId: string) => {
	const token = tokens.get(tokenId);
	const summary = token ? hub?.get(token.link.heroId) : null;
	if (writer && summary) {
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
	binding = next;
	if (binding) {
		hub = new HubClient({
			connection: binding,
			onSummary: onSummary,
			onDeleted: () => announce(),
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

// #region Scene: linked tokens and badges

const drawBadges = async () => {
	if (!sceneReady) {
		return;
	}
	const [ dpi, existing ] = await Promise.all([
		OBR.scene.grid.getDpi(),
		OBR.scene.local.getItems(item => BADGE_KEY in item.metadata)
	]);
	const desired = new Map<string, Badge>();
	for (const [ tokenId, token ] of tokens) {
		// Players don't see badges on tokens the GM has hidden
		if ((token.link.conditions.length === 0) || (!token.visible && (self.role !== 'GM'))) {
			continue;
		}
		const bounds = await OBR.scene.items.getItemBounds([ tokenId ]);
		layoutBadges(tokenId, token.link.conditions, bounds, dpi).forEach(badge => desired.set(badge.id, badge));
	}

	const stale = existing.filter(item => {
		const badge = desired.get(item.id);
		return !badge || ((item.metadata[BADGE_KEY] as { signature?: string } | undefined)?.signature !== badgeSignature(badge));
	});
	const keep = new Set(existing.filter(item => !stale.includes(item)).map(item => item.id));
	const added = [ ...desired.values() ].filter(badge => !keep.has(badge.id)).map(badge => buildLabel()
		.id(badge.id)
		.plainText(badge.text)
		.position(badge.position)
		.attachedTo(badge.tokenId)
		.layer('ATTACHMENT')
		.locked(true)
		.disableHit(true)
		.disableAttachmentBehavior([ 'ROTATION', 'SCALE' ])
		.visible(tokens.get(badge.tokenId)?.visible ?? true)
		.fontSize(badge.fontSize)
		.fontWeight(600)
		.fillColor('#ffffff')
		.backgroundColor(badge.color)
		.backgroundOpacity(0.9)
		.cornerRadius(Math.round(badge.fontSize / 3))
		.padding(Math.round(badge.fontSize / 4))
		.pointerHeight(0)
		.metadata({ [BADGE_KEY]: { tokenId: badge.tokenId, signature: badgeSignature(badge) } })
		.build());

	if (stale.length > 0) {
		await OBR.scene.local.deleteItems(stale.map(item => item.id));
	}
	if (added.length > 0) {
		await OBR.scene.local.addItems(added);
	}
};

const scheduleBadges = () => {
	if (badgeTimer !== null) {
		clearTimeout(badgeTimer);
	}
	badgeTimer = setTimeout(() => {
		badgeTimer = null;
		drawBadges().catch(error => log(`Couldn't draw badges: ${String(error)}`));
	}, BADGE_DEBOUNCE_MS);
};

// Wants a token only if it doesn't already show its hero's latest summary
const wantIfStale = (item: Item) => {
	const link = readLink(item.metadata);
	const summary = link ? hub?.get(link.heroId) : null;
	if (writer && summary && (planTokenUpdate(item.metadata, summary).kind === 'write')) {
		writer.want(item.id, summary);
	}
};

const itemsChanged = (items: Item[]) => {
	const arrived: Item[] = [];
	let badgesChanged = false;
	const present = new Set<string>();
	items.forEach(item => {
		const link = readLink(item.metadata);
		if (!link) {
			return;
		}
		present.add(item.id);
		const signature = tokenSignature(item.metadata);
		const known = tokens.get(item.id);
		tokens.set(item.id, { name: item.name, link: link, visible: item.visible, seen: signature });
		if (!known || (known.link.heroId !== link.heroId)) {
			// Newly linked, or new in this scene (such as a Party Continuity copy)
			arrived.push(item);
			badgesChanged = true;
			return;
		}
		if ((JSON.stringify(known.link.conditions) !== JSON.stringify(link.conditions)) || (known.visible !== item.visible)) {
			badgesChanged = true;
		}
		if ((known.seen !== signature) && (lastWritten.get(item.id) !== signature)) {
			// Someone else changed it: give them a quiet window
			writer?.touch(item.id);
			const summary = hub?.get(link.heroId);
			// A restore (Party Continuity) or a stale copy: the token shows an older revision than the server's
			if (summary && (link.syncedRev !== summary.rev)) {
				writer?.want(item.id, summary);
			}
		}
	});
	[ ...tokens.keys() ].filter(id => !present.has(id)).forEach(id => {
		tokens.delete(id);
		lastWritten.delete(id);
		writer?.forget(id);
		badgesChanged = true;
	});
	if ((arrived.length > 0) && writer) {
		// Let the scene settle, then bring the new tokens up to date (report §4.8)
		writer.settle();
		arrived.forEach(wantIfStale);
	}
	if (badgesChanged) {
		scheduleBadges();
	}
	announce();
};

const sceneReadyChanged = async (ready: boolean) => {
	sceneReady = ready;
	tokens.clear();
	lastWritten.clear();
	if (ready) {
		itemsChanged(await OBR.scene.items.getItems());
	}
	scheduleBadges();
	announce();
};

// #endregion

// #region Context menus (the GM)

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
			// The token keeps the stats it shows; it just stops following the hero
			OBR.scene.items.updateItems(context.items.map(item => item.id), drafts => {
				drafts.forEach(draft => {
					delete draft.metadata[LINK_KEY];
				});
			});
		}
	});
};

// #endregion

OBR.onReady(async () => {
	const [ connectionId, role, name ] = await Promise.all([ OBR.player.getConnectionId(), OBR.player.getRole(), OBR.player.getName() ]);
	self = { connectionId: connectionId, role: role, name: name };
	const toMember = (player: { connectionId: string, role: 'GM' | 'PLAYER', name: string }): PartyMember => ({ connectionId: player.connectionId, role: player.role, name: player.name });
	party = (await OBR.party.getPlayers()).map(toMember);

	OBR.player.onChange(player => {
		if ((player.role !== self.role) || (player.name !== self.name)) {
			self = { ...self, role: player.role, name: player.name };
			electionChanged();
			scheduleBadges();
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
