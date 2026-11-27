// Exactly one client writes each token (spike finding 7: two writers lose about half the updates). Every client
// computes the same choice from the party: a GM first (the GM's laptop at this group's table), then the lowest
// connection id, which also settles a GM signed in on two devices.

export interface PartyMember {
	connectionId: string;
	role: 'GM' | 'PLAYER';
	name: string;
	// The Owlbear user (Player.id): the same on each of a person's connections, and what an item's
	// lastModifiedUserId names
	playerId?: string;
}

export const electWriter = (members: PartyMember[]): PartyMember | null => {
	const sorted = [ ...members ].sort((a, b) => {
		if (a.role !== b.role) {
			return a.role === 'GM' ? -1 : 1;
		}
		return a.connectionId < b.connectionId ? -1 : (a.connectionId > b.connectionId ? 1 : 0);
	});
	return sorted[0] ?? null;
};
