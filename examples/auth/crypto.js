/**
 * Crypto utilities using OpenPGP.js
 * 
 * Provides crypto operations for Proton authentication.
 */

import * as openpgp from 'openpgp';

let initialized = false;

/**
 * Initialize the crypto module.
 */
export async function initCrypto() {
    if (initialized) {
        return;
    }
    
    // Configure OpenPGP.js for Node.js
    openpgp.config.allowInsecureDecryptionWithSigningKeys = true;
    
    initialized = true;
}

/**
 * Compute SHA-512 hash
 */
export async function sha512(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-512', data);
    return new Uint8Array(hashBuffer);
}

/**
 * Import an armored private key
 */
export async function importPrivateKey(armoredKey, passphrase) {
    const privateKey = await openpgp.readPrivateKey({ armoredKey });
    if (passphrase) {
        return await openpgp.decryptKey({ privateKey, passphrase });
    }
    return privateKey;
}

/**
 * Import an armored public key
 */
export async function importPublicKey(armoredKey) {
    return await openpgp.readKey({ armoredKey });
}

/**
 * Verify a cleartext signed message
 */
export async function verifyCleartextMessage({ armoredCleartextMessage, verificationKeys }) {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: armoredCleartextMessage });
    const result = await openpgp.verify({
        message,
        verificationKeys: Array.isArray(verificationKeys) ? verificationKeys : [verificationKeys],
    });
    
    // Check signature validity
    let verified = false;
    if (result.signatures && result.signatures.length > 0) {
        try {
            await result.signatures[0].verified;
            verified = true;
        } catch {
            verified = false;
        }
    }
    
    return {
        data: result.data,
        verified,
    };
}

/**
 * Decrypt a message
 */
export async function decryptMessage({ armoredMessage, decryptionKeys, verificationKeys, format }) {
    const message = await openpgp.readMessage({ armoredMessage });
    return await openpgp.decrypt({
        message,
        decryptionKeys: Array.isArray(decryptionKeys) ? decryptionKeys : [decryptionKeys],
        verificationKeys: verificationKeys ? (Array.isArray(verificationKeys) ? verificationKeys : [verificationKeys]) : undefined,
        format,
    });
}

// Export openpgp for direct use
export { openpgp };
