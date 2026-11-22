import { DST_METADATA_KEY, type DstHeroTokenData, type DstSyncedFields, type DstTokenRead, patchDstHeroData, readDstToken, summaryToDstPatch } from './dst-token.ts';
import OBR, { type Item, type Permission } from '@owlbear-rodeo/sdk';
import './style.css';

// Phase 0 spike tool (report §10): can this extension write Draw Steel Tools' token data,
// under which permissions, and how many updates are lost when writes collide?

const CHANNEL_PREFIX = 'com.treyrumsey.table-link-spike';
const BURST_CHANNEL = `${CHANNEL_PREFIX}/burst`;
const BURST_DONE_CHANNEL = `${CHANNEL_PREFIX}/burst-done`;
const VERIFY_DELAY_MS = 1500;
const BURST_SETTLE_MS = 1500;
const TABLE_FIELDS = [ 'notes', 'gmOnly', 'heroicResourceButton' ] as const;
const FORM_FIELDS = [ 'stamina', 'staminaMaximum', 'temporaryStamina', 'recoveries', 'surges', 'heroicResource' ] as const;

interface BurstRequest {
	runId: string;
	itemId: string;
	count: number;
	intervalMs: number;
	overlap: boolean;
	from: string;
}

interface BurstResult {
	runId: string;
	playerName: string;
	writes: number;
	errors: number;
}

const element = <T extends HTMLElement>(id: string) => {
	const found = document.getElementById(id);
	if (!found) {
		throw new Error(`Missing #${id}`);
	}
	return found as T;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const errorText = (error: unknown) => error instanceof Error ? error.message : JSON.stringify(error);

// #region Log

const logLines: string[] = [];
const logOutput = element<HTMLTextAreaElement>('log-output');

const log = (message: string) => {
	logLines.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
	logOutput.value = logLines.join('\n');
	logOutput.scrollTop = logOutput.scrollHeight;
};

element('clear-log').addEventListener('click', () => {
	logLines.length = 0;
	logOutput.value = '';
});

element('copy-log').addEventListener('click', () => {
	navigator.clipboard.writeText(logOutput.value)
		.then(() => log('Log copied to the clipboard'))
		.catch(() => {
			// Owlbear's extension iframe may not allow clipboard access
			logOutput.focus();
			logOutput.select();
			log('Clipboard blocked: the log is selected, press Cmd+C / Ctrl+C');
		});
});

// #endregion

// #region State

let me = { id: '', name: '', role: 'PLAYER' as 'GM' | 'PLAYER' };
let permissions: Permission[] = [];
let sceneReady = false;
let selectedId: string | null = null;
const playerNames = new Map<string, string>();
const lastDstJson = new Map<string, string>();
let activeBurst: { request: BurstRequest, results: BurstResult[] } | null = null;

const who = (playerId: string) => {
	if (playerId === me.id) {
		return 'you';
	}
	return playerNames.get(playerId) ?? `player ${playerId.slice(0, 8)}`;
};

const describeRead = (read: DstTokenRead) => {
	switch (read.kind) {
		case 'hero':
			return 'hero';
		case 'other':
			return `${read.type} token (not a hero)`;
		case 'none':
			return 'none (not a Draw Steel Tools token)';
		case 'invalid':
			return `INVALID: ${read.problems.join('; ')}`;
	}
};

const describeHero = (data: DstHeroTokenData) => {
	return `stamina ${data.stamina}/${data.staminaMaximum} temp ${data.temporaryStamina}, recoveries ${data.recoveries}, surges ${data.surges}, `
		+ `${data.heroicResourceName || 'resource'} ${data.heroicResource}`;
};

// What the room's permissions predict. The write test shows what Owlbear actually does.
const predictWrite = (item: Item) => {
	if (me.role === 'GM') {
		return { allowed: true, reason: 'you are the GM' };
	}
	const update = `${item.layer}_UPDATE` as Permission;
	if (!permissions.includes(update)) {
		return { allowed: false, reason: `the room does not grant ${update}` };
	}
	if ((item.layer === 'CHARACTER') && permissions.includes('CHARACTER_OWNER_ONLY') && (item.createdUserId !== me.id)) {
		return { allowed: false, reason: 'CHARACTER_OWNER_ONLY is on and you did not create this token' };
	}
	return { allowed: true, reason: `the room grants ${update}` };
};

// #endregion

// #region Rendering

const renderStatus = () => {
	const ownerOnly = permissions.includes('CHARACTER_OWNER_ONLY');
	const rows: [string, string][] = [
		[ 'Room', OBR.room.id ],
		[ 'You', `${me.name} (${me.role}, ${me.id.slice(0, 8)})` ],
		[ 'Players can update characters', permissions.includes('CHARACTER_UPDATE') ? 'yes' : 'no' ],
		[ 'Owner only', ownerOnly ? 'on (players can only edit tokens they created)' : 'off' ],
		[ 'Scene', sceneReady ? 'ready' : 'not open' ]
	];
	element('status').replaceChildren(...rows.flatMap(([ term, value ]) => {
		const dt = document.createElement('dt');
		dt.textContent = term;
		const dd = document.createElement('dd');
		dd.textContent = value;
		return [ dt, dd ];
	}));
};

const setControlsEnabled = (enabled: boolean) => {
	[ 'write-button', 'sample-button', 'burst-button' ].forEach(id => element<HTMLButtonElement>(id).disabled = !enabled);
};

const fillForm = (data: DstHeroTokenData) => {
	FORM_FIELDS.forEach(field => element<HTMLInputElement>(`field-${field}`).value = String(data[field] ?? ''));
	element<HTMLInputElement>('field-heroicResourceName').value = data.heroicResourceName ?? '';
};

const getSelectedItem = async () => {
	if (!selectedId || !sceneReady) {
		return null;
	}
	const [ item ] = await OBR.scene.items.getItems([ selectedId ]);
	return item ?? null;
};

const refreshSelection = async () => {
	const panel = element('token-info');
	const item = await getSelectedItem();
	if (!item) {
		panel.textContent = 'Select a Draw Steel Tools hero token.';
		setControlsEnabled(false);
		return;
	}

	const read = readDstToken(item.metadata);
	const prediction = predictWrite(item);
	panel.textContent = [
		`${item.name} (${item.layer} layer)`,
		`Created by ${who(item.createdUserId)}; last changed by ${who(item.lastModifiedUserId)}`,
		`Expect to be allowed to write: ${prediction.allowed ? 'yes' : 'no'} (${prediction.reason})`,
		`DST data: ${read.kind === 'hero' ? describeHero(read.data) : describeRead(read)}`
	].join('\n');

	if (read.kind === 'hero') {
		fillForm(read.data);
	}
	setControlsEnabled(read.kind === 'hero');
};

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleRefresh = () => {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => void refreshSelection(), 200);
};

// #endregion

// #region Write and verify

const checkWrite = async (itemId: string, patch: DstSyncedFields, before: DstHeroTokenData, label: string, when: string) => {
	const [ item ] = await OBR.scene.items.getItems([ itemId ]);
	const read: DstTokenRead = item ? readDstToken(item.metadata) : { kind: 'none' };
	if (!item || (read.kind !== 'hero')) {
		log(`${label} check ${when}: token data is now ${describeRead(read)}`);
		return;
	}

	const mismatches = (Object.keys(patch) as (keyof DstSyncedFields)[])
		.filter(field => read.data[field] !== patch[field])
		.map(field => `${field} is ${read.data[field]}, wrote ${patch[field]}`);
	const tableChanges = TABLE_FIELDS.filter(field => read.data[field] !== before[field]);
	log(`${label} check ${when}: ${mismatches.length === 0 ? 'OK' : `MISMATCH (${mismatches.join('; ')})`}`
		+ `${tableChanges.length > 0 ? `; table fields changed: ${tableChanges.join(', ')}` : '; notes/gmOnly/button untouched'}`
		+ `; last changed by ${who(item.lastModifiedUserId)}`);
};

const writeAndVerify = async (itemId: string, patch: DstSyncedFields, label: string) => {
	const [ beforeItem ] = await OBR.scene.items.getItems([ itemId ]);
	const before = beforeItem ? readDstToken(beforeItem.metadata) : null;
	if (!beforeItem || (before?.kind !== 'hero')) {
		log(`${label}: not a Draw Steel Tools hero token`);
		return;
	}
	log(`${label}: expect allowed = ${predictWrite(beforeItem).allowed}`);

	let outcome = 'updater did not run';
	const started = performance.now();
	try {
		// A filter (not item objects) makes the SDK re-read the token just before applying the change
		await OBR.scene.items.updateItems([ itemId ], items => {
			items.forEach(item => {
				const read = readDstToken(item.metadata);
				if (read.kind !== 'hero') {
					outcome = `skipped: ${describeRead(read)}`;
					return;
				}
				const result = patchDstHeroData(read.data, patch);
				if (!result.ok) {
					outcome = `refused: ${result.problems.join('; ')}`;
				} else if (result.changed.length === 0) {
					outcome = 'skipped: values already match';
				} else {
					item.metadata[DST_METADATA_KEY] = result.data;
					outcome = `wrote ${result.changed.join(', ')}`;
				}
			});
		});
	} catch (error) {
		log(`${label}: updateItems failed: ${errorText(error)}`);
		return;
	}
	log(`${label}: ${outcome} (${Math.round(performance.now() - started)} ms)`);

	if (outcome.startsWith('wrote')) {
		await checkWrite(itemId, patch, before.data, label, 'immediately');
		// A write the server refuses may be rolled back after the local update
		await sleep(VERIFY_DELAY_MS);
		await checkWrite(itemId, patch, before.data, label, `after ${VERIFY_DELAY_MS} ms`);
	}
};

const readForm = (): DstSyncedFields => {
	const patch: DstSyncedFields = {};
	FORM_FIELDS.forEach(field => {
		const text = element<HTMLInputElement>(`field-${field}`).value.trim();
		if (text.length > 0) {
			patch[field] = Number(text);
		}
	});
	patch.heroicResourceName = element<HTMLInputElement>('field-heroicResourceName').value;
	return patch;
};

element('write-form').addEventListener('submit', event => {
	event.preventDefault();
	if (selectedId) {
		void writeAndVerify(selectedId, readForm(), 'Write');
	}
});

element('sample-button').addEventListener('click', async () => {
	const item = await getSelectedItem();
	const read = item ? readDstToken(item.metadata) : null;
	if (!item || (read?.kind !== 'hero')) {
		return;
	}
	// Negative stamina (dying) and negative Clarity must both pass DST's schema and render
	const patch = summaryToDstPatch({
		name: read.data.name ?? item.name,
		staminaMax: 18,
		stamina: -2,
		staminaTemp: 3,
		recoveries: 6,
		surges: 1,
		resource: { name: 'Clarity', value: -3 }
	});
	await writeAndVerify(item.id, patch, 'Talent sample');
});

// #endregion

// #region Burst test

const runBurst = async (request: BurstRequest) => {
	const pending: Promise<void>[] = [];
	let errors = 0;
	for (let i = 0; i < request.count; i++) {
		const write = OBR.scene.items.updateItems([ request.itemId ], items => {
			items.forEach(item => {
				const read = readDstToken(item.metadata);
				if (read.kind === 'hero') {
					const result = patchDstHeroData(read.data, { stamina: (read.data.stamina ?? 0) + 1 });
					if (result.ok) {
						item.metadata[DST_METADATA_KEY] = result.data;
					}
				}
			});
		}).catch(error => {
			errors++;
			log(`Burst write failed: ${errorText(error)}`);
		});
		if (request.overlap) {
			pending.push(write);
		} else {
			await write;
		}
		await sleep(request.intervalMs);
	}
	await Promise.all(pending);
	return { writes: request.count - errors, errors: errors };
};

const readStamina = async (itemId: string) => {
	const [ item ] = await OBR.scene.items.getItems([ itemId ]);
	const read = item ? readDstToken(item.metadata) : null;
	return read?.kind === 'hero' ? (read.data.stamina ?? 0) : null;
};

element('burst-button').addEventListener('click', async () => {
	const item = await getSelectedItem();
	const start = item ? await readStamina(item.id) : null;
	if (!item || (start === null) || activeBurst) {
		return;
	}

	const broadcast = element<HTMLInputElement>('burst-broadcast').checked;
	const request: BurstRequest = {
		runId: crypto.randomUUID().slice(0, 8),
		itemId: item.id,
		count: Math.max(1, Number(element<HTMLInputElement>('burst-count').value) || 1),
		intervalMs: Math.max(0, Number(element<HTMLInputElement>('burst-interval').value) || 0),
		overlap: element<HTMLInputElement>('burst-overlap').checked,
		from: me.name
	};
	activeBurst = { request: request, results: [] };
	element<HTMLButtonElement>('burst-button').disabled = true;
	log(`Burst ${request.runId} on ${item.name}: start stamina ${start}; ${request.count} x +1 every ${request.intervalMs} ms, `
		+ `${request.overlap ? 'overlapping' : 'one at a time'}, ${broadcast ? 'on every open client' : 'on this client only'}`);

	if (broadcast) {
		await OBR.broadcast.sendMessage(BURST_CHANNEL, request, { destination: 'REMOTE' });
	}
	const local = await runBurst(request);
	activeBurst.results.push({ runId: request.runId, playerName: `${me.name} (you)`, ...local });

	if (broadcast) {
		// Wait for the other clients' results; clients without this popover open never answer
		const expectedClients = (await OBR.party.getPlayers()).length + 1;
		const deadline = Date.now() + (request.count * request.intervalMs) + 5000;
		while ((activeBurst.results.length < expectedClients) && (Date.now() < deadline)) {
			await sleep(200);
		}
	}
	await sleep(BURST_SETTLE_MS);

	const final = await readStamina(item.id);
	const writes = activeBurst.results.reduce((total, result) => total + result.writes, 0);
	log(`Burst ${request.runId}: final stamina ${final}, expected ${start + writes} from ${activeBurst.results.length} client(s): `
		+ `${final === null ? 'token no longer a hero' : `${start + writes - final} lost update(s)`}`);
	activeBurst.results.forEach(result => log(`  ${result.playerName}: ${result.writes} writes, ${result.errors} errors`));
	activeBurst = null;
	element<HTMLButtonElement>('burst-button').disabled = false;
});

const onBurstRequest = async (data: unknown) => {
	const request = data as BurstRequest;
	if (!request?.runId || !request.itemId) {
		return;
	}
	log(`Burst ${request.runId} requested by ${request.from}: running ${request.count} writes`);
	const result = await runBurst(request);
	const done: BurstResult = { runId: request.runId, playerName: me.name, ...result };
	await OBR.broadcast.sendMessage(BURST_DONE_CHANNEL, done, { destination: 'REMOTE' });
	log(`Burst ${request.runId}: sent ${result.writes} writes, ${result.errors} errors`);
};

const onBurstDone = (data: unknown) => {
	const result = data as BurstResult;
	if (activeBurst && (result?.runId === activeBurst.request.runId)) {
		activeBurst.results.push(result);
	}
};

// #endregion

// #region Scene events

const diffDst = (previousJson: string, json: string) => {
	const previous = JSON.parse(previousJson) as Record<string, unknown>;
	const current = JSON.parse(json) as Record<string, unknown>;
	const changes = [ ...new Set([ ...Object.keys(previous), ...Object.keys(current) ]) ]
		.filter(field => JSON.stringify(previous[field]) !== JSON.stringify(current[field]))
		.map(field => `${field} ${JSON.stringify(previous[field])} -> ${JSON.stringify(current[field])}`);
	// The editing client sees DST save twice; the second save only reorders the keys
	return changes.length > 0 ? changes.join(', ') : 'no value changes (keys reordered)';
};

const onItemsChange = (items: Item[]) => {
	const verbose = element<HTMLInputElement>('log-verbose').checked;
	const present = new Set<string>();
	items.forEach(item => {
		const value = item.metadata[DST_METADATA_KEY];
		if (value === undefined) {
			return;
		}
		present.add(item.id);
		const json = JSON.stringify(value);
		const previous = lastDstJson.get(item.id);
		if (verbose && (previous !== undefined) && (previous !== json)) {
			log(`DST change on ${item.name} by ${who(item.lastModifiedUserId)}: ${diffDst(previous, json)}`);
		} else if (verbose && (previous === undefined)) {
			log(`DST token appeared: ${item.name}`);
		}
		lastDstJson.set(item.id, json);
	});
	[ ...lastDstJson.keys() ].filter(id => !present.has(id)).forEach(id => lastDstJson.delete(id));
	if (selectedId && present.has(selectedId)) {
		scheduleRefresh();
	}
};

const logSnapshot = async (reason: string) => {
	if (!sceneReady) {
		log(`Snapshot (${reason}): no scene open`);
		return;
	}
	const items = await OBR.scene.items.getItems(item => item.metadata[DST_METADATA_KEY] !== undefined);
	log(`Snapshot (${reason}): ${items.length} Draw Steel Tools token(s)`);
	items.forEach(item => {
		const read = readDstToken(item.metadata);
		lastDstJson.set(item.id, JSON.stringify(item.metadata[DST_METADATA_KEY]));
		log(`  ${item.name}: ${read.kind === 'hero' ? describeHero(read.data) : describeRead(read)}; last changed by ${who(item.lastModifiedUserId)}`);
	});
};

element('snapshot-button').addEventListener('click', () => void logSnapshot('requested'));

// #endregion

const start = async () => {
	me = { id: await OBR.player.getId(), name: await OBR.player.getName(), role: await OBR.player.getRole() };
	permissions = await OBR.room.getPermissions();
	sceneReady = await OBR.scene.isReady();
	(await OBR.party.getPlayers()).forEach(player => playerNames.set(player.id, player.name));
	renderStatus();
	element<HTMLButtonElement>('snapshot-button').disabled = false;
	log(`Ready in room ${OBR.room.id} as ${me.name} (${me.role}); owner only ${permissions.includes('CHARACTER_OWNER_ONLY') ? 'on' : 'off'}`);

	const theme = await OBR.theme.getTheme();
	document.documentElement.style.colorScheme = theme.mode === 'DARK' ? 'dark' : 'light';

	OBR.party.onChange(players => players.forEach(player => playerNames.set(player.id, player.name)));
	OBR.room.onPermissionsChange(updated => {
		permissions = updated;
		renderStatus();
		log(`Room permissions changed: owner only ${updated.includes('CHARACTER_OWNER_ONLY') ? 'on' : 'off'}, `
			+ `character updates ${updated.includes('CHARACTER_UPDATE') ? 'allowed' : 'not allowed'}`);
		scheduleRefresh();
	});
	OBR.player.onChange(player => {
		const id = player.selection?.[0] ?? null;
		if (id !== selectedId) {
			selectedId = id;
			scheduleRefresh();
		}
	});
	OBR.scene.onReadyChange(ready => {
		sceneReady = ready;
		renderStatus();
		log(`Scene ${ready ? 'ready' : 'closed'}`);
		lastDstJson.clear();
		if (ready) {
			void logSnapshot('scene ready');
		}
		scheduleRefresh();
	});
	OBR.scene.items.onChange(onItemsChange);
	OBR.broadcast.onMessage(BURST_CHANNEL, event => void onBurstRequest(event.data));
	OBR.broadcast.onMessage(BURST_DONE_CHANNEL, event => onBurstDone(event.data));

	selectedId = (await OBR.player.getSelection())?.[0] ?? null;
	await logSnapshot('opened');
	await refreshSelection();
};

if (OBR.isAvailable) {
	OBR.onReady(() => {
		start().catch(error => log(`Start-up failed: ${errorText(error)}`));
	});
} else {
	element('not-in-obr').hidden = false;
	log('Not running inside Owlbear Rodeo');
}
