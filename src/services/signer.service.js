import { logger } from '../utils/logger.js';
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
export class SignerService {
    signerUrl;
    signerApiKey;
    serviceName;
    timeout = 15000; // 15 seconds
    constructor(serviceName = 'gas-worker') {
        this.signerUrl = process.env.SIGNER_BASE_URL || process.env.SIGNER_SERVICE_URL || 'http://localhost:3001';
        this.signerApiKey = process.env.SIGNER_API_KEY || '';
        this.serviceName = serviceName;
        if (!this.signerApiKey) {
            logger.warn('SIGNER_API_KEY not set - signer service calls may fail');
        }
    }
    /**
     * Sign a transaction via Signer Service
     *
     * @param request - Contains chain, wallet_group_id, derivation_index, unsigned_tx_payload
     * @returns Signed transaction (signed_tx)
     */
    async signTransaction(request) {
        try {
            logger.debug({
                chain: request.chain,
                walletGroupId: request.wallet_group_id,
                derivationIndex: request.derivation_index,
            }, 'Calling signer service');
            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);
            try {
                // Build payload with chain, wallet_group_id, derivation_index
                const payload = {
                    chain: request.chain,
                    wallet_group_id: request.wallet_group_id,
                    derivation_index: request.derivation_index,
                };
                // Include tx_intent if provided (TRON intent-based signing)
                if (request.tx_intent !== undefined) {
                    payload.tx_intent = request.tx_intent;
                }
                // Include unsigned_tx if provided (BSC hex string)
                else if (request.unsigned_tx !== undefined) {
                    payload.unsigned_tx = request.unsigned_tx;
                }
                const signerEndpoint = `${this.signerUrl}/api/sign`;
                logger.debug({ endpoint: signerEndpoint, chain: request.chain }, 'Calling signer service endpoint');
                const response = await fetch(signerEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.signerApiKey}`,
                        'X-Service-Name': this.serviceName,
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                if (!response.ok) {
                    // Try to parse structured error response
                    let errorData;
                    try {
                        errorData = await response.json();
                    }
                    catch {
                        const errorText = await response.text();
                        logger.error({
                            status: response.status,
                            statusText: response.statusText,
                            errorText,
                            signerUrl: this.signerUrl
                        }, 'Signer service returned non-JSON error response');
                        throw new Error(`Signer service error (${response.status}): ${errorText}`);
                    }
                    // STEP 4: Handle structured errors
                    const errorCode = errorData.code || errorData.error_code || errorData.errorCode || 'UNKNOWN';
                    const errorMessage = errorData.message || errorData.error || errorData.errorMessage || 'Unknown error';
                    logger.error({
                        status: response.status,
                        errorCode,
                        errorMessage,
                        errorData,
                        signerUrl: this.signerUrl
                    }, 'Signer service returned error response');
                    if (errorCode === 'UNAUTHORIZED' || response.status === 401) {
                        const err = new Error(`Signer unauthorized: ${errorMessage}`);
                        err.isRetryable = false;
                        err.errorType = 'unauthorized';
                        err.errorCode = 'UNAUTHORIZED';
                        throw err;
                    }
                    else if (errorCode === 'VAULT_UNAVAILABLE' || errorCode === 'VAULT_ERROR') {
                        const err = new Error(`Vault unavailable: ${errorMessage}`);
                        err.isRetryable = true;
                        err.errorType = 'vault_unavailable';
                        err.errorCode = 'VAULT_UNAVAILABLE';
                        throw err;
                    }
                    else if (errorCode === 'DERIVATION_FAILED' || errorCode === 'DERIVATION_ERROR') {
                        const err = new Error(`Derivation failed: ${errorMessage}`);
                        err.isRetryable = false;
                        err.errorType = 'derivation_failed';
                        err.errorCode = 'DERIVATION_FAILED';
                        throw err;
                    }
                    else if (errorCode === 'SIGNING_FAILED' || errorCode === 'SIGNING_ERROR') {
                        const err = new Error(`Signing failed: ${errorMessage}`);
                        err.isRetryable = true;
                        err.errorType = 'signing_failed';
                        err.errorCode = 'SIGNING_FAILED';
                        err.status = response.status;
                        err.errorData = errorData;
                        throw err;
                    }
                    else {
                        // Unknown error code - log full details and throw
                        const err = new Error(`Signer service error (${response.status}): ${errorMessage}`);
                        err.isRetryable = true; // Default to retryable for unknown errors
                        err.errorType = 'signer_error';
                        err.errorCode = errorCode;
                        err.status = response.status;
                        err.errorData = errorData;
                        throw err;
                    }
                }
                const result = await response.json();
                logger.info({
                    chain: request.chain,
                    txHash: result.tx_hash || 'pending',
                }, 'Transaction signed successfully');
                return result;
            }
            catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    const err = new Error('Signer service timeout (15s)');
                    err.isRetryable = true;
                    err.errorType = 'timeout';
                    throw err;
                }
                // Enhanced error logging for fetch failures
                const fetchFailureError = new Error(`Signer service connection failed: ${fetchError.message || 'Unknown error'}`);
                fetchFailureError.isRetryable = true;
                fetchFailureError.errorType = 'network_error';
                fetchFailureError.originalError = fetchError.message;
                fetchFailureError.signerUrl = this.signerUrl;
                throw fetchFailureError;
            }
        }
        catch (error) {
            // Do NOT log sensitive payloads
            logger.error({
                error: error.message,
                chain: request.chain,
                signerUrl: this.signerUrl,
                errorType: error.errorType || 'unknown',
                errorCode: error.errorCode,
                originalError: error.originalError,
            }, 'Failed to sign transaction via signer service');
            throw error;
        }
    }
    /**
     * Health check for signer service
     */
    async healthCheck() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s for health check
            try {
                const response = await fetch(`${this.signerUrl}/health`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.signerApiKey}`,
                        'X-Service-Name': this.serviceName,
                    },
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                return response.ok;
            }
            catch (fetchError) {
                clearTimeout(timeoutId);
                return false;
            }
        }
        catch (error) {
            logger.error({ error: error.message }, 'Signer service health check failed');
            return false;
        }
    }
}
//# sourceMappingURL=signer.service.js.map