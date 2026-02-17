# SIGNER SERVICE: Add TRC20 Token Transfer Support

## Current Status

The consolidation worker now sends `tx_intent.type = 'trc20_transfer'` for TRC20 tokens (USDT, etc.).

The signer service currently only supports:
- `send_trx` (native TRX transfers)

## Required Changes

### 1. Update TX Intent Handler

Add support for `trc20_transfer` intent type in the TRON signer handler.

### 2. Expected TX Intent Format

```typescript
{
  type: 'trc20_transfer',
  from: 'TEBtYR3x7ZZv76bV98LPfoPEZwBahBrtmq',  // User wallet
  to: 'TTKGa1o4kyTThYgaR3zvKRbStB7p6RaKW6',    // Hot wallet
  contract_address: 'TXYZopYRdj2D9XRtbG4uU...', // USDT contract on TRON
  amount: '500000000'                          // Amount in smallest unit (6 decimals for USDT)
}
```

### 3. Implementation Logic

```typescript
if (tx_intent.type === 'send_trx') {
  // Existing native TRX transfer logic
  const unsignedTx = await tronWeb.transactionBuilder.sendTrx(
    tx_intent.to,
    tx_intent.amount_sun,
    tx_intent.from
  );
}
else if (tx_intent.type === 'trc20_transfer') {
  // NEW: TRC20 token transfer logic
  
  // 1. Get TRC20 contract instance
  const contract = await tronWeb.contract().at(tx_intent.contract_address);
  
  // 2. Build transfer() call
  const unsignedTx = await contract.transfer(
    tx_intent.to,
    tx_intent.amount
  ).send({
    feeLimit: 100000000, // 100 TRX fee limit for TRC20 transfers
    callValue: 0,        // No TRX sent with this call
    from: tx_intent.from,
    shouldPollResponse: false // Don't wait for confirmation, just get the tx
  });
  
  // 3. Sign and broadcast (existing logic)
}
```

### 4. Alternative Implementation (Manual Contract Call)

If the above doesn't work, use `triggerSmartContract`:

```typescript
else if (tx_intent.type === 'trc20_transfer') {
  const functionSelector = 'transfer(address,uint256)';
  const parameter = [
    { type: 'address', value: tx_intent.to },
    { type: 'uint256', value: tx_intent.amount }
  ];
  
  const unsignedTx = await tronWeb.transactionBuilder.triggerSmartContract(
    tx_intent.contract_address,
    functionSelector,
    {
      feeLimit: 100000000,  // 100 TRX
      callValue: 0,
    },
    parameter,
    tronWeb.address.toHex(tx_intent.from)
  );
  
  // unsignedTx.transaction contains the unsigned transaction
  const txToSign = unsignedTx.transaction;
}
```

### 5. Validation

Before building the transaction, validate:

```typescript
if (tx_intent.type === 'trc20_transfer') {
  if (!tx_intent.contract_address) {
    throw new Error('contract_address is required for trc20_transfer');
  }
  if (!tx_intent.amount) {
    throw new Error('amount is required for trc20_transfer');
  }
  
  // Validate contract address format (Tron base58 or hex)
  try {
    tronWeb.address.toHex(tx_intent.contract_address);
  } catch (error) {
    throw new Error('Invalid contract_address format');
  }
}
```

### 6. Enhanced Logging

```typescript
logger.debug({
  tx_type: tx_intent.type,
  from: tx_intent.from,
  to: tx_intent.to,
  contract_address: tx_intent.contract_address || 'N/A',
  amount: tx_intent.amount || tx_intent.amount_sun,
}, 'Building TRON transaction');
```

### 7. Error Handling

Map TRC20-specific errors:

- `balance is not sufficient` → User doesn't have enough tokens
- `contract validate error` → Contract doesn't exist or is invalid
- `insufficient energy` → Not enough TRX for gas

### 8. Testing

Test with USDT on TRON Nile testnet:
- Contract: `TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj` (USDT on Nile)
- Verify the transaction appears as a TRC20 transfer on TronScan
- Verify the recipient receives the tokens

## Expected Behavior After Fix

1. Consolidation worker sends `trc20_transfer` intent
2. Signer builds TRC20 contract call transaction
3. Signer signs with user's private key
4. Signer broadcasts transaction
5. Returns `tx_hash` to consolidation worker
6. Consolidation worker moves job to `confirming`
7. Confirmation worker verifies TRC20 transfer on-chain

## Compatibility

This change is backward-compatible:
- `send_trx` still works for native TRX transfers
- `trc20_transfer` is new and optional

