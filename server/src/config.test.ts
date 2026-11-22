import { describe, expect, it } from 'vitest';
import { parseDeviceTokens } from './config.ts';

describe('parseDeviceTokens', () => {
	it('keeps the = padding of base64 tokens', () => {
		expect(parseDeviceTokens('abc==Alice, xyz=Bob')).toEqual({ 'abc=': 'Alice', 'xyz': 'Bob' });
	});

	it('rejects entries without a token or a seat, without echoing them', () => {
		expect(() => parseDeviceTokens('secret-token')).toThrow('entry 1 must look like token=Seat');
		expect(() => parseDeviceTokens('a=Alice,secret=')).toThrow('entry 2 must look like token=Seat');
		expect(() => parseDeviceTokens('=Alice')).toThrow('entry 1');
		expect(() => parseDeviceTokens(' , ')).toThrow('no token=Seat entries');
	});
});
