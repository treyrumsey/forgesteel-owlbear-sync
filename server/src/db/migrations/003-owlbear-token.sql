-- Phase 4: the Owlbear extension signs in with a room-scoped token. It's a device in the GM seat, so revocation,
-- the GM's device list and the hub's revocation all apply, but it can't sign in to the Warehouse API and the
-- hub sends it hero summaries only.
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'device' CHECK (kind IN ('device', 'owlbear'));
