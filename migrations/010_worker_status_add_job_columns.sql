-- Add job counter columns to worker_status if they are missing
-- (e.g. table existed before 009 or was created without these columns)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_status' AND column_name = 'jobs_processed'
  ) THEN
    ALTER TABLE worker_status ADD COLUMN jobs_processed BIGINT NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_status' AND column_name = 'jobs_success'
  ) THEN
    ALTER TABLE worker_status ADD COLUMN jobs_success BIGINT NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_status' AND column_name = 'jobs_failed'
  ) THEN
    ALTER TABLE worker_status ADD COLUMN jobs_failed BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;
