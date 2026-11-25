ALTER TABLE chapters ADD COLUMN input_hash TEXT;
ALTER TABLE chapters ADD COLUMN media_revision TEXT;
ALTER TABLE chapters ADD COLUMN has_timing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN book_revision TEXT;
