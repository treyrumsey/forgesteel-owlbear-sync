import { createHmac, randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so codes are easy to read aloud and type
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const JOIN_CODE_LENGTH = 10;

export type SecretKind = 'device' | 'gm-key' | 'join-code';

export const generateDeviceToken = () => `sst_${randomBytes(32).toString('base64url')}`;

export const generateGmKey = () => `ssgm_${randomBytes(32).toString('base64url')}`;

// About 50 bits; rate limits and rotation protect it, because it's the only short secret
export const generateJoinCode = () => {
	// 256 is a multiple of 32, so taking each byte mod 32 is uniform
	const code = [ ...randomBytes(JOIN_CODE_LENGTH) ].map(byte => CROCKFORD[byte % 32]).join('');
	return `${code.slice(0, 5)}-${code.slice(5)}`;
};

// Accepts any case, spaces and dashes, and the letters people mistake for digits
export const normalizeJoinCode = (input: string): string | null => {
	const code = input.toUpperCase()
		.replace(/[\s-]/g, '')
		.replace(/[IL]/g, '1')
		.replace(/O/g, '0');
	const valid = (code.length === JOIN_CODE_LENGTH) && [ ...code ].every(char => CROCKFORD.includes(char));
	return valid ? code : null;
};

// Secrets are stored only as keyed hashes, so a copy of the database file alone can't be used to sign in
export const hashSecret = (key: string, kind: SecretKind, value: string) => {
	return createHmac('sha256', key).update(`${kind}\n${value}`).digest('hex');
};
