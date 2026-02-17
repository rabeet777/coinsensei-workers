import type { SignerRequest, SignerResponse } from '../types/gas-topup-queue.js';
/**
 * Signer Service Client
 *
 * Communicates with the Signer Service which:
 * - Retrieves mnemonics from HashiCorp Vault
 * - Derives private keys
 * - Signs transactions
 * - Returns signed transactions
 *
 * NO private keys are stored or handled by workers
 */
export declare class SignerService {
    private readonly signerUrl;
    private readonly signerApiKey;
    private readonly serviceName;
    private readonly timeout;
    constructor(serviceName?: string);
    /**
     * Sign a transaction via Signer Service
     *
     * @param request - Contains chain, wallet_group_id, derivation_index, unsigned_tx_payload
     * @returns Signed transaction (signed_tx)
     */
    signTransaction(request: SignerRequest): Promise<SignerResponse>;
    /**
     * Health check for signer service
     */
    healthCheck(): Promise<boolean>;
}
//# sourceMappingURL=signer.service.d.ts.map