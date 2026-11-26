import { LOCAL_CHANNEL, ROOM_KEY } from './keys.ts';
import { type LocalMessage, type Status } from './messages.ts';
import { parseConnection, readBinding } from './connection.ts';
import OBR from '@owlbear-rodeo/sdk';
import { testConnection } from './hub-client.ts';
import './style.css';

// The extension's popover: status, and the GM's connect box. The work happens in the background page
// (background.ts), which this asks for its status over a LOCAL broadcast.

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const HUB_TEXT: Record<Status['hub'], string> = {
	off: 'not connected',
	connecting: 'connecting…',
	live: 'live',
	offline: 'offline'
};

let role: 'GM' | 'PLAYER' = 'PLAYER';
let last: Status | null = null;

const row = (term: string, value: string, className = '') => {
	const dt = document.createElement('dt');
	dt.textContent = term;
	const dd = document.createElement('dd');
	dd.textContent = value;
	if (className) {
		dd.className = className;
	}
	return [ dt, dd ];
};

const render = (status: Status) => {
	last = status;
	const rows = [
		...row('Room', status.bound ? (status.roomName || 'connected') : 'not connected to Sync Steel', status.bound ? '' : 'bad'),
		...(status.bound ? row('Sync Steel', status.hubDetail && (status.hub !== 'live') ? `${HUB_TEXT[status.hub]}: ${status.hubDetail}` : HUB_TEXT[status.hub], status.hub === 'live' ? 'ok' : 'bad') : []),
		...(status.bound ? row('Writes tokens', status.writerName || 'nobody') : []),
		...row('Scene', status.sceneReady ? 'open' : 'none open')
	];
	element('status').replaceChildren(...rows);

	element('connect-section').hidden = role !== 'GM';
	element('player-note').hidden = role === 'GM';
	element('disconnect-button').hidden = !status.bound;
	element('connect-button').textContent = status.bound ? 'Replace connection' : 'Connect';

	const list = element('linked');
	list.replaceChildren(...(status.linked.length === 0
		? [ 'None yet' ]
		: status.linked.map(token => {
			const item = document.createElement('li');
			item.textContent = `${token.tokenName} → ${token.heroName}${token.stats ? `: ${token.stats}` : ''}${token.current ? '' : ' (updating)'}`;
			return item;
		})).map(item => {
		if (typeof item === 'string') {
			const li = document.createElement('li');
			li.textContent = item;
			li.className = 'note';
			return li;
		}
		return item;
	}));
};

const say = (text: string, ok: boolean) => {
	const result = element('connect-result');
	result.textContent = text;
	result.className = ok ? 'note ok' : 'note bad';
};

const connect = async (event: Event) => {
	event.preventDefault();
	const connection = parseConnection(element<HTMLTextAreaElement>('connection').value);
	if (!connection) {
		say('That isn\'t a Sync Steel connection. Copy it from GM tools → Owlbear on the Sync Steel page.', false);
		return;
	}
	const button = element<HTMLButtonElement>('connect-button');
	button.disabled = true;
	say('Checking…', true);
	try {
		const result = await testConnection(connection);
		if (!result.ok) {
			say(result.reason, false);
			return;
		}
		await OBR.room.setMetadata({ [ROOM_KEY]: { api: connection.api, token: connection.token } });
		element<HTMLTextAreaElement>('connection').value = '';
		say(`Connected to ${result.roomName || 'the room'}.`, true);
	} catch (error) {
		say(`Couldn't connect: ${error instanceof Error ? error.message : String(error)}`, false);
	} finally {
		button.disabled = false;
	}
};

const disconnect = async () => {
	if (!confirm('Disconnect this Owlbear room from Sync Steel? Linked tokens keep their links and stats, but stop updating.')) {
		return;
	}
	await OBR.room.setMetadata({ [ROOM_KEY]: undefined });
	say('Disconnected.', true);
};

if (!document.referrer && (window.parent === window)) {
	element('not-in-obr').hidden = false;
}

OBR.onReady(async () => {
	role = await OBR.player.getRole();
	OBR.player.onChange(player => {
		role = player.role;
		if (last) {
			render(last);
		}
	});
	OBR.broadcast.onMessage(LOCAL_CHANNEL, event => {
		const message = event.data as LocalMessage;
		if (message.type === 'status') {
			render(message.status);
		}
	});
	element('connect-form').addEventListener('submit', connect);
	element('disconnect-button').addEventListener('click', disconnect);

	// Until the background page answers, show what the room metadata says
	const binding = readBinding((await OBR.room.getMetadata())[ROOM_KEY]);
	render({ bound: binding !== null, api: binding?.api ?? '', roomName: '', hub: 'off', hubDetail: '', writerName: '', isWriter: false, sceneReady: await OBR.scene.isReady(), linked: [] });
	OBR.broadcast.sendMessage(LOCAL_CHANNEL, { type: 'status?' } satisfies LocalMessage, { destination: 'LOCAL' });
});
