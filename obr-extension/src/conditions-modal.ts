import { CONDITIONS_MODAL_ID, LINK_KEY, LOCAL_CHANNEL } from './keys.ts';
import { CONDITION_ENDS, CONDITION_TYPES, needsText, newCondition } from './conditions.ts';
import { conditionColor, conditionLabel } from './badges.ts';
import type { LocalMessage } from './messages.ts';
import OBR from '@owlbear-rodeo/sdk';
import type { SummaryCondition } from './summary.ts';
import { readLink } from './links.ts';
import './style.css';

// The Conditions modal, opened from a linked token's Conditions menu (Phase 5). It shows the hero's conditions
// from the token's link and asks the background page to add or remove one; the background page sends it to
// the api, and the token (and its badges) update once the server's summary comes back.

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokenId = new URLSearchParams(window.location.search).get('token') ?? '';

let busy = false;
const waiting = new Map<string, (result: { ok: boolean, reason: string }) => void>();

const note = (text: string) => {
	element('conditions-note').textContent = text;
};

const send = (message: LocalMessage) => OBR.broadcast.sendMessage(LOCAL_CHANNEL, message, { destination: 'LOCAL' });

// Resolves once the server has answered, or after 10 s
const request = (add: SummaryCondition[], remove: string[]) => {
	const requestId = crypto.randomUUID();
	return new Promise<{ ok: boolean, reason: string }>(resolve => {
		const timer = setTimeout(() => {
			waiting.delete(requestId);
			resolve({ ok: false, reason: 'Sync Steel didn\'t answer' });
		}, 10_000);
		waiting.set(requestId, result => {
			clearTimeout(timer);
			resolve(result);
		});
		send({ type: 'conditions', requestId: requestId, tokenId: tokenId, add: add, remove: remove }).catch(() => undefined);
	});
};

const change = async (add: SummaryCondition[], remove: string[], doing: string) => {
	if (busy) {
		return;
	}
	busy = true;
	note(`${doing}…`);
	const result = await request(add, remove);
	busy = false;
	note(result.ok ? 'Saved in Forge Steel. The token updates in a moment.' : `Not saved: ${result.reason}.`);
};

const render = (conditions: SummaryCondition[]) => {
	if (!busy && (conditions.length === 0)) {
		note('No conditions.');
	}
	element('conditions').replaceChildren(...conditions.map(condition => {
		const item = document.createElement('li');
		const swatch = document.createElement('span');
		swatch.className = 'swatch';
		swatch.style.background = conditionColor(condition.type);
		const label = document.createElement('span');
		label.className = 'label';
		label.textContent = conditionLabel(condition);
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.textContent = 'Remove';
		remove.setAttribute('aria-label', `Remove ${conditionLabel(condition)}`);
		remove.addEventListener('click', () => {
			change([], [ condition.id ], `Removing ${conditionLabel(condition)}`);
		});
		item.append(swatch, label, remove);
		return item;
	}));
};

const option = (value: string, label: string) => {
	const node = document.createElement('option');
	node.value = value;
	node.textContent = label;
	return node;
};

const setUpForm = () => {
	const type = element<HTMLSelectElement>('type');
	const ends = element<HTMLSelectElement>('ends');
	const text = element<HTMLInputElement>('text');
	type.replaceChildren(...CONDITION_TYPES.map(value => option(value, value)));
	ends.replaceChildren(...CONDITION_ENDS.map(end => option(end.value, end.label)));
	ends.value = 'Save ends';
	const showText = () => {
		element('text-label').hidden = !needsText(type.value);
	};
	type.addEventListener('change', showText);
	showText();

	element<HTMLFormElement>('add-form').addEventListener('submit', event => {
		event.preventDefault();
		const made = newCondition(type.value, ends.value, text.value, crypto.randomUUID());
		if (!made.ok) {
			note(made.problem);
			return;
		}
		change([ made.condition ], [], `Adding ${conditionLabel(made.condition)}`).then(() => {
			text.value = '';
		});
	});
};

element('close-button').addEventListener('click', () => {
	OBR.modal.close(CONDITIONS_MODAL_ID);
});

OBR.onReady(async () => {
	setUpForm();
	OBR.broadcast.onMessage(LOCAL_CHANNEL, event => {
		const message = event.data as LocalMessage;
		if (message.type === 'conditions.done') {
			waiting.get(message.requestId)?.({ ok: message.ok, reason: message.reason });
			waiting.delete(message.requestId);
		}
	});

	const show = (metadata: Record<string, unknown>, name: string) => {
		const link = readLink(metadata);
		if (!link) {
			note('This token is no longer linked to a hero.');
			element('conditions').replaceChildren();
			return;
		}
		element('hero-name').textContent = name;
		render(link.conditions);
	};

	const [ token ] = await OBR.scene.items.getItems([ tokenId ]);
	if (!token) {
		note('That token is no longer in the scene.');
		return;
	}
	show(token.metadata, token.name);
	// The writer updates the token's link once the server has the change
	OBR.scene.items.onChange(items => {
		const changed = items.find(item => item.id === tokenId);
		if (changed && (JSON.stringify(changed.metadata[LINK_KEY]) !== JSON.stringify(token.metadata[LINK_KEY]))) {
			token.metadata = changed.metadata;
			show(changed.metadata, changed.name);
		}
	});
});
