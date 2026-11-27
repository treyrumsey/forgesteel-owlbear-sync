// The Live panels switch (Sync Steel page): whether the branded build's hero drawers (Resources, Vitals,
// Inventory) are Sync Steel's live copies, which follow changes made elsewhere while open, or upstream's
// originals, which keep the copy they opened with. Saved per device; on unless turned off.

const KEY = 'sync-steel-live-panels';

const storage = () => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};

export const LivePanels = {
	isOn: () => storage()?.getItem(KEY) !== 'off',

	set: (on: boolean) => {
		storage()?.setItem(KEY, on ? 'on' : 'off');
	}
};
