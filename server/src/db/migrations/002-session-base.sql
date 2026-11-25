-- Phase 3: when a session's save is merged, the server keeps what that session sent, gzipped. Its copy is
-- what it sent, not the merged revision, so its next save from that copy merges against it (store/heroes.ts).
-- NULL means the session's copy is the revision in `rev` itself.
ALTER TABLE hero_session_writes ADD COLUMN data BLOB;
