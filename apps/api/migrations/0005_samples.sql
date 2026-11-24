-- A Sample: one voice reading the start of the Document of one episode. A row is one clip a client asked for.
-- The clip is in R2 at users/<userId>/episodes/<episodeId>/samples/<voice>.m4a when the state is Ready.
CREATE TABLE samples (
  episode_id TEXT NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  voice TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Requested', 'Ready', 'Failed')),
  -- ISO 8601 from toISOString. The oldest request is claimed first.
  requested_at TEXT NOT NULL,
  -- The lease of the current claim: the SHA-256 hex of its lease token, and when it was made. A Requested row
  -- whose claim is older than SAMPLE_LEASE_MS can be claimed again. Both NULL until the first claim.
  lease_hash TEXT,
  claimed_at TEXT,
  fail_reason TEXT,
  PRIMARY KEY (episode_id, voice)
);

CREATE INDEX samples_claimable ON samples (state, requested_at);
