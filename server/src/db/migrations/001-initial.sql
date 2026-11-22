-- Sync Steel schema, version 1. Timestamps are ISO 8601 UTC strings.
-- Hero and homebrew bodies are stored as JSON text and never queried into.

CREATE TABLE rooms (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	join_code_hash TEXT NOT NULL UNIQUE,
	gm_key_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	code_rotated_at TEXT NOT NULL,
	last_export_at TEXT
) STRICT;

CREATE TABLE seats (
	id TEXT PRIMARY KEY,
	room_id TEXT NOT NULL REFERENCES rooms (id),
	name TEXT NOT NULL,
	is_gm INTEGER NOT NULL DEFAULT 0 CHECK (is_gm IN (0, 1)),
	created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX seats_room_name ON seats (room_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX seats_room_gm ON seats (room_id) WHERE is_gm = 1;

CREATE TABLE devices (
	id TEXT PRIMARY KEY,
	seat_id TEXT NOT NULL REFERENCES seats (id),
	token_hash TEXT NOT NULL UNIQUE,
	label TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
) STRICT;
CREATE INDEX devices_seat ON devices (seat_id);

-- Rows are soft-deleted and never removed, so a hero id's revision numbers are never reused
CREATE TABLE heroes (
	room_id TEXT NOT NULL REFERENCES rooms (id),
	id TEXT NOT NULL,
	seat_id TEXT NOT NULL REFERENCES seats (id),
	data TEXT NOT NULL,
	hash TEXT NOT NULL,
	rev INTEGER NOT NULL,
	-- The first revision of this copy; a base older than this belongs to a deleted copy
	created_rev INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	PRIMARY KEY (room_id, id)
) STRICT;
CREATE INDEX heroes_seat ON heroes (seat_id);

-- Merge bases (Phase 3) and GM restores. data is the gzipped hero JSON.
CREATE TABLE hero_revisions (
	room_id TEXT NOT NULL,
	hero_id TEXT NOT NULL,
	rev INTEGER NOT NULL,
	data BLOB NOT NULL,
	hash TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('device', 'import', 'restore')),
	seat_id TEXT,
	device_id TEXT,
	sid TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (room_id, hero_id, rev),
	FOREIGN KEY (room_id, hero_id) REFERENCES heroes (room_id, id)
) STRICT;

-- The revision each session (JWT sid) last wrote or matched: the later of this and the stamp is the merge base
CREATE TABLE hero_session_writes (
	room_id TEXT NOT NULL,
	hero_id TEXT NOT NULL,
	sid TEXT NOT NULL,
	rev INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (room_id, hero_id, sid)
) STRICT;

-- Shared by every seat in the room, because heroes depend on them
CREATE TABLE homebrew (
	room_id TEXT NOT NULL REFERENCES rooms (id),
	id TEXT NOT NULL,
	data TEXT NOT NULL,
	hash TEXT NOT NULL,
	rev INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	updated_by_seat TEXT,
	deleted_at TEXT,
	PRIMARY KEY (room_id, id)
) STRICT;

CREATE TABLE seat_data (
	seat_id TEXT NOT NULL REFERENCES seats (id),
	key TEXT NOT NULL CHECK (key IN ('session', 'hidden-setting-ids')),
	data TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (seat_id, key)
) STRICT;

CREATE TABLE audit_log (
	id INTEGER PRIMARY KEY,
	room_id TEXT NOT NULL REFERENCES rooms (id),
	at TEXT NOT NULL,
	seat_id TEXT,
	device_id TEXT,
	action TEXT NOT NULL,
	detail TEXT
) STRICT;
CREATE INDEX audit_log_room_at ON audit_log (room_id, at);
