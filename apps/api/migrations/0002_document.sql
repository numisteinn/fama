-- Byte size of the stored Document (`document.json` in R2). NULL until the worker uploads it.
ALTER TABLE episodes ADD COLUMN document_size INTEGER;
