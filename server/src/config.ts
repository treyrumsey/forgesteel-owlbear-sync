// "token=Seat,token2=Seat2" -> { token: 'Seat', token2: 'Seat2' }.
// Splits at the last '=', because base64 tokens end in '=' padding.
export const parseDeviceTokens = (value: string): Record<string, string> => {
	const entries = value.split(',')
		.map(pair => pair.trim())
		.filter(pair => pair.length > 0)
		.map((pair, index) => {
			const separator = pair.lastIndexOf('=');
			const token = separator > 0 ? pair.slice(0, separator).trim() : '';
			const seat = separator > 0 ? pair.slice(separator + 1).trim() : '';
			if (!token || !seat) {
				// Don't echo the entry: it may contain a real token
				throw new Error(`STUB_DEVICE_TOKENS entry ${index + 1} must look like token=Seat`);
			}
			return [ token, seat ] as const;
		});

	if (entries.length === 0) {
		throw new Error('STUB_DEVICE_TOKENS has no token=Seat entries');
	}
	return Object.fromEntries(entries);
};

export const parseList = (value: string) => value.split(',').map(item => item.trim()).filter(item => item.length > 0);
