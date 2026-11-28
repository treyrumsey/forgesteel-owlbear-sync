import type { SummaryCondition } from './summary.ts';

// Condition labels (decisions.md "Condition labels in token-labels' stack"). Each condition on a linked hero is
// a shared Owlbear Label attached to the token, made to look and stack like the labels from Seamus Finlayson's
// token-labels extension (github.com/SeamusFinlayson/token-labels, pinned in contract/pins.json):
// - token-labels finds a token's labels by an id starting `<tokenId>-label`, so ours use that prefix too. Its
//   next label then goes into the next slot, and its tidy-up click moves ours along with its own.
// - Only the elected writer creates, moves and deletes ours (background.ts), and only ours: we know them by
//   BADGE_KEY in their metadata, which token-labels ignores.
// token-labels has no license, so nothing is copied from it: these are the same visual values and stacking
// rule, written here.

// How token-labels' labels look by default
export const LABEL_STYLE = {
	fontFamily: 'Roboto, sans-serif',
	fontSize: 16,
	fontWeight: 400,
	fillOpacity: 0.87,
	backgroundOpacity: 0.9,
	// Both scale with the scene's grid; the label itself stays the same size on screen at any zoom
	cornerRadius: (dpi: number) => (dpi / 150) * 6,
	padding: (dpi: number) => (dpi / 150) * 2
};

// Its stack, in scene units from the token's top-left: the first label 15 below the top, the second below
// that, then the rest going up above the first
const SLOT_START = 15;
const SLOT_SPACING = 35;

// Slot 0, 1, 2, 3… sits this many steps from the first: 0, +1, −1, −2…
const slotStep = (slot: number) => (slot <= 1 ? slot : 1 - slot);

export interface Point {
	x: number;
	y: number;
}

export const slotPosition = (anchor: Point, slot: number): Point => ({ x: anchor.x, y: anchor.y + SLOT_START + (SLOT_SPACING * slotStep(slot)) });

// The slot a label at this position is in, or null if it's not at one (moved by hand, say)
export const slotAt = (anchor: Point, position: Point) => {
	const step = Math.round((position.y - anchor.y - SLOT_START) / SLOT_SPACING);
	if (step === 0 || step === 1) {
		return step;
	}
	return step < 0 ? 1 - step : null;
};

export const labelId = (tokenId: string, conditionId: string) => `${tokenId}-label-sync-steel-${conditionId}`;

// Whether token-labels would count this item as one of the token's labels
export const inStack = (tokenId: string, itemId: string) => itemId.startsWith(`${tokenId}-label`);

// What we put in the metadata of our labels (under BADGE_KEY)
export interface LabelTag {
	tokenId: string;
	conditionId: string;
}

export const readTag = (value: unknown): LabelTag | null => {
	if ((typeof value !== 'object') || (value === null)) {
		return null;
	}
	const tag = value as Record<string, unknown>;
	return (typeof tag.tokenId === 'string') && (typeof tag.conditionId === 'string') ? { tokenId: tag.tokenId, conditionId: tag.conditionId } : null;
};

// Draw Steel's conditions, with a colour each, for the Conditions modal's swatches
const COLORS: Record<string, string> = {
	Bleeding: '#b3261e',
	Dazed: '#7e57c2',
	Frightened: '#6a1b9a',
	Grabbed: '#ef6c00',
	Prone: '#5d4037',
	Restrained: '#c62828',
	Slowed: '#1565c0',
	Taunted: '#d81b60',
	Weakened: '#455a64'
};

export const conditionColor = (type: string) => COLORS[type] ?? '#37474f';

const MAX_TEXT = 24;

// Worded as token-labels' Draw Steel list words them
const ENDS: Record<string, string> = {
	'End of turn': 'EoT',
	'Save ends': 'SE'
};

// A condition's text, such as "Bleeding (EoT)"; custom and quick conditions show their own name
export const conditionLabel = (condition: SummaryCondition) => {
	const custom = (condition.type === 'Custom Condition') || (condition.type === 'Quick Condition') || !condition.type;
	const name = (custom ? condition.text.trim() : condition.type) || 'Condition';
	const ends = ENDS[condition.ends];
	const text = ends ? `${name} (${ends})` : name;
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
};

// A label attached to the token, in token-labels' stack: ours if it carries our tag
export interface StackLabel {
	id: string;
	text: string;
	position: Point;
	tag: LabelTag | null;
}

export interface NewLabel {
	id: string;
	tokenId: string;
	conditionId: string;
	text: string;
	position: Point;
}

export interface LabelPlan {
	add: NewLabel[];
	update: { id: string, text?: string, position?: Point }[];
	delete: string[];
}

const samePoint = (a: Point, b: Point) => (Math.abs(a.x - b.x) < 0.5) && (Math.abs(a.y - b.y) < 0.5);

// What to change so the token's labels show the hero's conditions. token-labels' own labels are never touched.
// When our set changes, ours are packed into the lowest free slots, after token-labels' own, so its next label
// (which takes the slot after however many there are) never lands on one of ours. Otherwise ours stay where
// they are, so a tidy-up click in token-labels isn't undone.
export const planLabels = (tokenId: string, anchor: Point, conditions: SummaryCondition[], existing: StackLabel[]): LabelPlan => {
	const stack = existing.filter(label => inStack(tokenId, label.id));
	const ours = new Map(stack.filter(label => label.tag?.tokenId === tokenId).map(label => [ label.tag!.conditionId, label ]));
	const theirs = stack.filter(label => label.tag?.tokenId !== tokenId);
	const wanted = conditions.filter((condition, index) => conditions.findIndex(c => c.id === condition.id) === index);
	const wantedIds = new Set(wanted.map(condition => condition.id));

	const plan: LabelPlan = {
		add: [],
		update: [],
		delete: [ ...ours.entries() ].filter(([ conditionId ]) => !wantedIds.has(conditionId)).map(([ , label ]) => label.id)
	};
	const setChanged = (plan.delete.length > 0) || wanted.some(condition => !ours.has(condition.id));

	const taken = new Set(theirs.map(label => slotAt(anchor, label.position)).filter(slot => slot !== null));
	let next = 0;
	const freeSlot = () => {
		while (taken.has(next)) {
			next += 1;
		}
		taken.add(next);
		return next;
	};

	wanted.forEach(condition => {
		const text = conditionLabel(condition);
		const label = ours.get(condition.id);
		const position = setChanged ? slotPosition(anchor, freeSlot()) : undefined;
		if (!label) {
			plan.add.push({ id: labelId(tokenId, condition.id), tokenId: tokenId, conditionId: condition.id, text: text, position: position! });
			return;
		}
		const change: LabelPlan['update'][number] = { id: label.id };
		if (label.text !== text) {
			change.text = text;
		}
		if (position && !samePoint(label.position, position)) {
			change.position = position;
		}
		if ((change.text !== undefined) || (change.position !== undefined)) {
			plan.update.push(change);
		}
	});
	return plan;
};

export const isEmptyPlan = (plan: LabelPlan) => (plan.add.length === 0) && (plan.update.length === 0) && (plan.delete.length === 0);
