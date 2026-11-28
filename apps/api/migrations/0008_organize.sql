-- Library organization: archive timestamp plus owner-edit locks so worker heartbeats and
-- document uploads never overwrite a title or author the owner explicitly set.
ALTER TABLE episodes ADD COLUMN archived_at TEXT;
ALTER TABLE episodes ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN author_locked INTEGER NOT NULL DEFAULT 0;
