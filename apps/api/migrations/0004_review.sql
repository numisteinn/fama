-- The stop for Review of one episode. NULL: none (it was not asked for, or it is done). 'Wanted': the episode was
-- added with review on, and its job stops when the worker stores the Document. 'Open': the job waits in Review.
-- A job in Review has job_state 'Queued' and review 'Open'. SQLite cannot add a value to the CHECK on job_state
-- without building the table again, and a migration that builds `episodes` again drops each column that a
-- migration with a later number added before it ran. So Review is a column of its own, and `claim` skips 'Open'.
ALTER TABLE episodes ADD COLUMN review TEXT CHECK (review IN ('Wanted', 'Open'));

-- The key of the published Document. Existing Documents use their original path.
ALTER TABLE episodes ADD COLUMN document_key TEXT;
