CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- A capability URL secret: stored in plain text so the server can print the feed URL again.
  feed_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Client tokens. Only the SHA-256 hex of the token is stored.
CREATE TABLE tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX tokens_user ON tokens (user_id);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  language TEXT,
  voice TEXT,
  speed REAL NOT NULL,
  duration_ms INTEGER,
  book_size INTEGER,
  cover_key TEXT,
  job_version INTEGER NOT NULL DEFAULT 0,
  job_state TEXT NOT NULL CHECK (job_state IN ('Queued', 'Running', 'Ready', 'Failed')),
  queued_at TEXT NOT NULL,
  worker_id TEXT,
  -- SHA-256 hex of the lease token of the current claim. Cleared when the job goes back to Queued.
  lease_hash TEXT,
  stage TEXT,
  done INTEGER,
  total INTEGER,
  heartbeat_at TEXT,
  finished_at TEXT,
  fail_reason TEXT,
  failed_at TEXT
);

CREATE INDEX episodes_user_created_at ON episodes (user_id, created_at DESC);
CREATE INDEX episodes_claimable ON episodes (job_state, queued_at);

CREATE TABLE chapters (
  episode_id TEXT NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (episode_id, idx)
);

CREATE TABLE voices (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  gender TEXT,
  seen_at TEXT NOT NULL
);
