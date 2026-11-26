// The string the GM pastes into the Owlbear extension (Phase 4): the api's address and the room's Owlbear token.
// obr-extension/src/connection.ts reads it; owlbear-connection.test.ts checks the two agree.

export interface OwlbearConnection {
	api: string;
	token: string;
}

const PREFIX = 'sync-steel-owlbear:';

const toBase64Url = (text: string) => {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	bytes.forEach(byte => binary += String.fromCharCode(byte));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export class OwlbearConnectionLogic {
	static encode = (connection: OwlbearConnection) => {
		return `${PREFIX}${toBase64Url(JSON.stringify({ api: connection.api.trim().replace(/\/+$/, ''), token: connection.token }))}`;
	};

	// Where the extension is served: fs-web builds it into /owlbear/ (Dockerfile.sync-steel)
	static getManifestUrl = (origin: string) => `${origin.replace(/\/+$/, '')}/owlbear/manifest.json`;
}
