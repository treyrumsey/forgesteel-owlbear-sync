// Sync Steel's own Owlbear keys (decisions.md "Name: Sync Steel"). Never put Sync Steel data inside Draw Steel
// Tools' object: DST drops unknown keys when it writes (spike finding 3).

const PREFIX = 'com.treyrumsey.sync-steel';

// Room metadata: the api address and the room's Owlbear token. Every client in the room can read it.
export const ROOM_KEY = `${PREFIX}/room`;

// Token metadata: the hero a token is linked to, the revision last written and the hero's conditions
export const LINK_KEY = `${PREFIX}/metadata`;

// Local items: condition badges drawn by each client
export const BADGE_KEY = `${PREFIX}/badge`;

// Broadcasts between this client's pages (background, popover, hero picker); always LOCAL
export const LOCAL_CHANNEL = `${PREFIX}/local`;

export const LINK_MENU_ID = `${PREFIX}/link`;
export const UNLINK_MENU_ID = `${PREFIX}/unlink`;
export const PICKER_MODAL_ID = `${PREFIX}/picker`;
export const CONDITIONS_MENU_ID = `${PREFIX}/conditions`;
export const CONDITIONS_MODAL_ID = `${PREFIX}/conditions-modal`;
