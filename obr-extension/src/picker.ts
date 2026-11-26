import { LINK_KEY, LOCAL_CHANNEL, PICKER_MODAL_ID } from './keys.ts';
import { newLink, rankHeroes } from './links.ts';
import type { HeroSummary } from './summary.ts';
import type { LocalMessage } from './messages.ts';
import OBR from '@owlbear-rodeo/sdk';
import './style.css';

// The GM's hero picker, opened as a modal by the token's Link to hero menu. The background page holds the
// room's heroes; this asks it for them, then writes the link onto the token. The background page writes the
// hero's stats once it sees the link.

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tokenId = new URLSearchParams(window.location.search).get('token') ?? '';

let tokenName = '';
let shown = false;

const close = () => OBR.modal.close(PICKER_MODAL_ID);

const note = (text: string) => {
	element('picker-note').textContent = text;
};

const link = async (hero: HeroSummary) => {
	await OBR.scene.items.updateItems([ tokenId ], drafts => {
		drafts.forEach(draft => {
			draft.metadata[LINK_KEY] = newLink(hero.heroId);
		});
	});
	await OBR.broadcast.sendMessage(LOCAL_CHANNEL, { type: 'linked', tokenId: tokenId } satisfies LocalMessage, { destination: 'LOCAL' });
	await OBR.notification.show(`${tokenName} now follows ${hero.name}`, 'SUCCESS');
	await close();
};

const render = (heroes: HeroSummary[]) => {
	shown = true;
	if (heroes.length === 0) {
		note('No heroes in the Sync Steel room yet.');
		return;
	}
	note('Heroes whose name matches the token come first.');
	element('heroes').replaceChildren(...rankHeroes(tokenName, heroes).map(({ hero, match }) => {
		const item = document.createElement('li');
		const button = document.createElement('button');
		button.type = 'button';
		button.className = match ? 'match' : '';
		button.textContent = hero.name;
		const detail = document.createElement('span');
		detail.className = 'detail';
		detail.textContent = `${hero.seatName} · ${hero.stamina}/${hero.staminaMax} stamina`;
		button.append(detail);
		button.addEventListener('click', () => {
			button.disabled = true;
			link(hero).catch(error => note(`Couldn't link: ${error instanceof Error ? error.message : String(error)}`));
		});
		item.append(button);
		return item;
	}));
};

element('cancel-button').addEventListener('click', () => {
	close();
});

OBR.onReady(async () => {
	const [ token ] = await OBR.scene.items.getItems([ tokenId ]);
	if (!token) {
		note('That token is no longer in the scene.');
		return;
	}
	tokenName = token.name;
	element('token-name').textContent = token.name;

	OBR.broadcast.onMessage(LOCAL_CHANNEL, event => {
		const message = event.data as LocalMessage;
		if ((message.type === 'heroes') && (message.synced || (message.heroes.length > 0))) {
			render(message.heroes);
		}
	});
	OBR.broadcast.sendMessage(LOCAL_CHANNEL, { type: 'heroes?' } satisfies LocalMessage, { destination: 'LOCAL' });
	setTimeout(() => {
		if (!shown) {
			note('Sync Steel isn\'t connected. Open the Sync Steel popover to check the connection.');
		}
	}, 5000);
});
