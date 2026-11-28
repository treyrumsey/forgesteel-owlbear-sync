import { type ConditionToken, conditionToken } from './condition-ops.ts';
import { chipGrid, chosenEnds, endsSwitch, requestConditions, watchTokens } from './condition-ui.ts';
import { LOCAL_CHANNEL } from './keys.ts';
import type { LocalMessage } from './messages.ts';
import OBR from '@owlbear-rodeo/sdk';
import { followTheme } from './theme.ts';
import './style.css';

// The Conditions panel in the token menu (background.ts createConditionsMenu): Draw Steel's nine conditions as
// chips for every selected character, linked to a hero or not. Its ⋯ opens the popover's Conditions tab, for
// custom conditions and removing one condition from one token.

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

followTheme();

let tokens: ConditionToken[] = [];
const pending = new Set<string>();

const render = () => {
	element('chips').replaceChildren(chipGrid(tokens, pending, toggle));
};

const toggle = (type: string) => {
	if (pending.has(type)) {
		return;
	}
	pending.add(type);
	render();
	requestConditions(tokens.map(token => token.id), { kind: 'toggle', type: type, ends: chosenEnds() }).finally(() => {
		pending.delete(type);
		render();
	});
};

element('ends').replaceChildren(endsSwitch());
render();

OBR.onReady(() => {
	element('more').addEventListener('click', () => {
		// The popover reads this when it opens, or hears the message if it's open already
		localStorage.setItem('sync-steel/tab', 'conditions');
		OBR.broadcast.sendMessage(LOCAL_CHANNEL, { type: 'conditions.open' } satisfies LocalMessage, { destination: 'LOCAL' }).catch(() => undefined);
		OBR.action.open().catch(() => undefined);
	});
	watchTokens(selected => {
		tokens = selected.map(conditionToken);
		render();
	});
});
