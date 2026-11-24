-- The worker's estimate of the wall time until Ready, while the job runs. NULL when it has none.
ALTER TABLE episodes ADD COLUMN remaining_ms INTEGER;
