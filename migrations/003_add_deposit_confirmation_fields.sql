-- Add confirmation tracking fields to deposits table

-- Add confirmations column (tracks how many confirmations deposit has)
ALTER TABLE deposits 
ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;

-- Add first_seen_block column (block where deposit was first detected)
ALTER TABLE deposits 
ADD COLUMN IF NOT EXISTS first_seen_block BIGINT;

-- Add confirmed_at timestamp (when deposit reached required confirmations)
ALTER TABLE deposits 
ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- Add credited_at timestamp (when balance was credited to user)
ALTER TABLE deposits 
ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ;

-- Create index for pending deposits (confirmation worker will query these)
CREATE INDEX IF NOT EXISTS idx_deposits_status_pending 
ON deposits(status) 
WHERE status = 'pending';

-- Create index for confirmation tracking
CREATE INDEX IF NOT EXISTS idx_deposits_confirmations 
ON deposits(confirmations);

-- Comment
COMMENT ON COLUMN deposits.confirmations IS 'Number of block confirmations (incremented by confirmation worker)';
COMMENT ON COLUMN deposits.first_seen_block IS 'Block number where deposit was first detected';
COMMENT ON COLUMN deposits.confirmed_at IS 'Timestamp when deposit reached required confirmations';
COMMENT ON COLUMN deposits.credited_at IS 'Timestamp when balance was credited to user';

