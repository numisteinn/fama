-- A row says that the timing file of this chapter is in R2. The worker uploads the timing file before the chapter
-- audio, so the row can be here before its row in `chapters`. A chapter without a row has no timing file.
CREATE TABLE timings (
  episode_id TEXT NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  PRIMARY KEY (episode_id, idx)
);
