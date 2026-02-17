-- Create function for safe balance crediting (no floating point math)
-- This function is idempotent and handles concurrent updates safely

CREATE OR REPLACE FUNCTION credit_user_asset_balance(
  p_uid UUID,
  p_asset_id UUID,
  p_amount NUMERIC
) RETURNS void AS $$
BEGIN
  -- Insert new balance record if doesn't exist, or update existing
  INSERT INTO user_asset_balance (uid, asset_id, available_balance_human)
  VALUES (p_uid, p_asset_id, p_amount)
  ON CONFLICT (uid, asset_id)
  DO UPDATE SET
    available_balance_human = user_asset_balance.available_balance_human + p_amount;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission to authenticated users (service role)
GRANT EXECUTE ON FUNCTION credit_user_asset_balance(UUID, UUID, NUMERIC) TO authenticated;

