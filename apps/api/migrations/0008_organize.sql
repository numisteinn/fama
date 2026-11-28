-- Library organization: when the owner archived the episode. NULL while it is in the inbox.
-- Archived episodes keep their audio and stay in the library, but the feed leaves them out.
ALTER TABLE episodes ADD COLUMN archived_at TEXT;

CREATE INDEX episodes_user_archived ON episodes (user_id, archived_at, created_at DESC);
