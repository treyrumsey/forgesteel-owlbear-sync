import type { SummaryCondition } from './summary.ts';

// Condition badges (report §4.7): each client draws its own local labels next to a linked token, from the
// conditions in the token's link. Nothing shared is written, so there's nothing for Party Continuity to copy.

export interface Bounds {
	min: { x: number, y: number };
	max: { x: number, y: number };
}

export interface Badge {
	// Stable, so redraws replace only what changed
	id: string;
	tokenId: string;
	text: string;
	color: string;
	position: { x: number, y: number };
	fontSize: number;
}

// Draw Steel's conditions, with a colour each; custom and quick conditions show their own text
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
const OTHER_COLOR = '#37474f';
const MAX_TEXT = 24;

const ENDS: Record<string, string> = {
	'End of turn': 'EoT',
	'Save ends': 'save'
};

export const conditionLabel = (condition: SummaryCondition) => {
	const custom = (condition.type === 'Custom Condition') || (condition.type === 'Quick Condition') || !condition.type;
	const name = (custom ? condition.text.trim() : condition.type) || 'Condition';
	const ends = ENDS[condition.ends];
	const text = ends ? `${name} (${ends})` : name;
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
};

// Stacked down the token's right-hand side, scaled to the grid
export const layoutBadges = (tokenId: string, conditions: SummaryCondition[], bounds: Bounds, dpi: number): Badge[] => {
	const fontSize = Math.max(8, Math.round(dpi * 0.16));
	const step = Math.round(fontSize * 1.7);
	return conditions.map((condition, index) => ({
		id: `${tokenId}-sync-steel-badge-${index}`,
		tokenId: tokenId,
		text: conditionLabel(condition),
		color: COLORS[condition.type] ?? OTHER_COLOR,
		position: { x: bounds.max.x + Math.round(fontSize * 0.3), y: bounds.min.y + (index * step) },
		fontSize: fontSize
	}));
};

// Everything that decides how a badge looks, so an unchanged badge isn't redrawn
export const badgeSignature = (badge: Badge) => JSON.stringify([ badge.text, badge.color, badge.position, badge.fontSize ]);
