import OBR, { type Item } from '@owlbear-rodeo/sdk';
import { chipGrid, chosenEnds, endsSwitch, requestConditions, toConditionTokens, tokenRow, watchTokens } from './condition-ui.ts';
import type { ConditionToken } from './condition-ops.ts';

// The popover's Conditions tab (popover.ts). With tokens selected: the same chips as the token menu's panel,
// a custom condition, and each token's conditions to remove one by one. With none: every character in the
// scene with conditions, and a button to clear every End of turn condition.

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let role: 'GM' | 'PLAYER' = 'PLAYER';
let selected: ConditionToken[] = [];
let all: Item[] = [];
const pending = new Set<string>();

const remove = (tokenId: string) => (conditionId: string) => {
	requestConditions([ tokenId ], { kind: 'remove', tokenId: tokenId, conditionId: conditionId });
};

const toggle = (type: string) => {
	if (pending.has(type)) {
		return;
	}
	pending.add(type);
	render();
	requestConditions(selected.map(token => token.id), { kind: 'toggle', type: type, ends: chosenEnds() }).finally(() => {
		pending.delete(type);
		render();
	});
};

// Players don't see hidden tokens in the overview
const shown = (items: Item[]) => items.filter(item => item.visible || (role === 'GM'));

const render = () => {
	const selecting = selected.length > 0;
	element('selection-view').hidden = !selecting;
	element('overview-view').hidden = selecting;
	if (selecting) {
		element('selection-title').textContent = selected.length === 1 ? selected[0].name || 'Unnamed token' : `${selected.length} tokens selected`;
		element('pop-chips').replaceChildren(chipGrid(selected, pending, toggle));
		element('selection-list').replaceChildren(...selected.map(token => tokenRow(token, remove(token.id))));
		return;
	}
	const withConditions = toConditionTokens(shown(all)).filter(token => token.conditions.length > 0);
	element('overview-list').replaceChildren(...withConditions.map(token => tokenRow(token, remove(token.id), () => {
		OBR.player.select([ token.id ]).catch(() => undefined);
	})));
	element('overview-empty').hidden = withConditions.length > 0;
	const endOfTurn = withConditions.filter(token => token.conditions.some(c => c.ends === 'End of turn'));
	const clear = element<HTMLButtonElement>('clear-eot');
	clear.hidden = endOfTurn.length === 0;
	clear.onclick = () => {
		const count = endOfTurn.reduce((sum, token) => sum + token.conditions.filter(c => c.ends === 'End of turn').length, 0);
		if (confirm(`Remove ${count} End of turn condition${count === 1 ? '' : 's'} from ${endOfTurn.length} token${endOfTurn.length === 1 ? '' : 's'}?`)) {
			requestConditions(endOfTurn.map(token => token.id), { kind: 'clear-ends', ends: 'End of turn' });
		}
	};
};

const setUpCustom = () => {
	const form = element<HTMLFormElement>('custom-form');
	const text = element<HTMLInputElement>('custom-text');
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (!text.value.trim() || (selected.length === 0)) {
			return;
		}
		const button = form.querySelector('button')!;
		button.disabled = true;
		requestConditions(selected.map(token => token.id), { kind: 'add', type: 'Custom Condition', ends: chosenEnds(), text: text.value }).then(ok => {
			if (ok) {
				text.value = '';
			}
		}).finally(() => {
			button.disabled = false;
		});
	});
};

export const startConditionsTab = async (playerRole: 'GM' | 'PLAYER') => {
	role = playerRole;
	element('pop-ends').replaceChildren(endsSwitch());
	setUpCustom();
	OBR.player.onChange(player => {
		if (player.role !== role) {
			role = player.role;
			render();
		}
	});
	await watchTokens((chosen, characters) => {
		selected = toConditionTokens(chosen);
		all = characters;
		render();
	});
};
