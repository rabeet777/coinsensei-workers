-- Migration: Add Postgres advisory lock functions for EVM funder nonce serialization
-- BSC Gas Top-Up Worker uses these to prevent nonce conflicts across multiple workers

-- Function to acquire advisory lock for EVM funder address
-- Uses hashtext() to convert address string to integer for pg_advisory_lock
CREATE OR REPLACE FUNCTION lock_evm_funder(key TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_lock(hashtext(key));
END;
$$;

-- Function to release advisory lock for EVM funder address
CREATE OR REPLACE FUNCTION unlock_evm_funder(key TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_unlock(hashtext(key));
END;
$$;

-- Grant execute permissions to application role (adjust role name as needed)
-- GRANT EXECUTE ON FUNCTION lock_evm_funder(TEXT) TO your_app_role;
-- GRANT EXECUTE ON FUNCTION unlock_evm_funder(TEXT) TO your_app_role;

