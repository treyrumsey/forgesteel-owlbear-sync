import { type ChipState, type ConditionOp, type ConditionToken, STANDARD_TYPES, chipStates, conditionToken } from './condition-ops.ts';
import OBR, { type Item } from '@owlbear-rodeo/sdk';
import { conditionColor, conditionLabel } from './labels.ts';
import { CONDITION_ENDS } from './conditions.ts';
import { LOCAL_CHANNEL } from './keys.ts';
import type { LocalMessage } from './messages.ts';

// What the Conditions panel (conditions-embed.ts) and the popover's Conditions tab (popover.ts) share: the
// selection's tokens, the Ends switch, the chip grid, a token's conditions, and asking the background page to
// make a change (background.ts applyConditions).

// #region The selection

// Characters only: the Conditions menu shows for them alone
export const isCharacter = (item: Item) => item.layer === 'CHARACTER';

// Calls back with the selected characters and every character in the scene, now and whenever either changes
export const watchTokens = async (changed: (selected: Item[], all: Item[]) => void) => {
	let selection: string[] = (await OBR.player.getSelection()) ?? [];
	let all: Item[] = (await OBR.scene.isReady()) ? (await OBR.scene.items.getItems(isCharacter)) : [];
	const emit = () => changed(all.filter(item => selection.includes(item.id)), all);
	OBR.player.onChange(player => {
		const next = player.selection ?? [];
		if (next.join() !== selection.join()) {
			selection = next;
			emit();
		}
	});
	OBR.scene.items.onChange(items => {
		all = items.filter(isCharacter);
		emit();
	});
	OBR.scene.onReadyChange(ready => {
		if (!ready) {
			all = [];
			emit();
		}
	});
	emit();
};

export const toConditionTokens = (items: Item[]) => items.map(conditionToken);

// #endregion

// #region Asking for a change

const waiting = new Map<string, (done: Extract<LocalMessage, { type: 'conditions.done' }>) => void>();
let listening = false;

const listen = () => {
	if (listening) {
		return;
	}
	listening = true;
	OBR.broadcast.onMessage(LOCAL_CHANNEL, event => {
		const message = event.data as LocalMessage;
		if (message.type === 'conditions.done') {
			waiting.get(message.requestId)?.(message);
		}
	});
};

// Resolves once the background page has made the change, or after 12 s; shows a notification if it failed
export const requestConditions = (tokenIds: string[], op: ConditionOp) => {
	listen();
	const requestId = crypto.randomUUID();
	return new Promise<boolean>(resolve => {
		const finish = (ok: boolean, reason: string, failed: number) => {
			clearTimeout(timer);
			waiting.delete(requestId);
			if (!ok) {
				const which = (failed > 0) && (failed < tokenIds.length) ? `${failed} of ${tokenIds.length} tokens: ` : '';
				OBR.notification.show(`Conditions not changed. ${which}${reason}.`, 'ERROR').catch(() => undefined);
			}
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false, 'Sync Steel didn\'t answer', 0), 12_000);
		waiting.set(requestId, done => finish(done.ok, done.reason, new Set(done.failures.map(f => f.tokenId)).size));
		const message: LocalMessage = { type: 'conditions.apply', requestId: requestId, tokenIds: tokenIds, op: op };
		OBR.broadcast.sendMessage(LOCAL_CHANNEL, message, { destination: 'LOCAL' }).catch(() => finish(false, 'the extension isn\'t ready', 0));
	});
};

// #endregion

// #region Ends: remembered on this device, shared by the panel and the popover

const ENDS_STORAGE = 'sync-steel/ends';
// Worded as the labels word them: "Bleeding (EoT)", "Dazed (SE)"
const SHORT_ENDS: Record<string, string> = { 'End of turn': 'EoT', 'Save ends': 'SE', 'Until removed': 'Until removed' };

export const chosenEnds = () => {
	const stored = localStorage.getItem(ENDS_STORAGE);
	return CONDITION_ENDS.some(end => end.value === stored) ? stored! : 'Save ends';
};

export const endsSwitch = () => {
	const group = document.createElement('div');
	group.className = 'segmented';
	group.setAttribute('role', 'radiogroup');
	group.setAttribute('aria-label', 'New conditions end');
	const render = () => {
		const chosen = chosenEnds();
		group.replaceChildren(...CONDITION_ENDS.map(end => {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = SHORT_ENDS[end.value] ?? end.label;
			button.title = `New conditions end: ${end.label}`;
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(end.value === chosen));
			button.addEventListener('click', () => {
				localStorage.setItem(ENDS_STORAGE, end.value);
				render();
			});
			return button;
		}));
	};
	// The other page may change it
	window.addEventListener('storage', event => {
		if (event.key === ENDS_STORAGE) {
			render();
		}
	});
	render();
	return group;
};

// #endregion

// #region Chips

const STATE_TEXT: Record<ChipState, string> = { all: 'on every selected token', some: 'on some selected tokens', none: 'not on any selected token' };

// One chip per Draw Steel condition: filled when every token has it, half filled when some do. A click toggles
// it for the whole selection (condition-ops.ts planApply). Pending chips wait for the change to land.
export const chipGrid = (tokens: ConditionToken[], pending: Set<string>, toggle: (type: string) => void) => {
	const grid = document.createElement('div');
	grid.className = 'chips';
	const states = chipStates(tokens);
	grid.replaceChildren(...STANDARD_TYPES.map(type => {
		const state = states.get(type) ?? 'none';
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = `chip ${state}${pending.has(type) ? ' pending' : ''}`;
		chip.style.setProperty('--condition', conditionColor(type));
		chip.textContent = type;
		chip.title = `${type}: ${STATE_TEXT[state]}. Click to ${state === 'all' ? 'remove it from' : 'add it to'} ${tokens.length === 1 ? 'the token' : 'every selected token'}.`;
		chip.setAttribute('aria-pressed', state === 'all' ? 'true' : (state === 'some' ? 'mixed' : 'false'));
		chip.disabled = tokens.length === 0;
		chip.addEventListener('click', () => toggle(type));
		return chip;
	}));
	return grid;
};

// #endregion

// #region A token's conditions

// The token's name (a button, if it can be selected) and each condition with its own remove button
export const tokenRow = (token: ConditionToken, remove: (conditionId: string) => void, select?: () => void) => {
	const row = document.createElement('li');
	row.className = 'token-row';
	const name = document.createElement(select ? 'button' : 'span');
	name.className = 'token-name';
	name.textContent = token.name || 'Unnamed token';
	if (select) {
		(name as HTMLButtonElement).type = 'button';
		name.title = `Select ${token.name}`;
		name.addEventListener('click', select);
	}
	if (token.heroId) {
		const tag = document.createElement('span');
		tag.className = 'hero-tag';
		tag.textContent = 'hero';
		tag.title = 'Linked to a Forge Steel hero: changes go to Forge Steel';
		name.append(tag);
	}
	const pills = document.createElement('ul');
	pills.className = 'pills';
	pills.replaceChildren(...(token.conditions.length === 0
		? [ Object.assign(document.createElement('li'), { className: 'note', textContent: 'No conditions' }) ]
		: token.conditions.map(condition => {
			const pill = document.createElement('li');
			pill.className = 'pill';
			pill.style.setProperty('--condition', conditionColor(condition.type));
			const text = document.createElement('span');
			text.textContent = conditionLabel(condition);
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = '✕';
			button.setAttribute('aria-label', `Remove ${conditionLabel(condition)} from ${token.name}`);
			button.title = 'Remove';
			button.addEventListener('click', () => {
				button.disabled = true;
				remove(condition.id);
			});
			pill.append(text, button);
			return pill;
		})));
	row.append(name, pills);
	return row;
};

// #endregion
