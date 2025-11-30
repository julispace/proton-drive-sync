/**
 * Proton Account Provider
 * 
 * Implements the ProtonDriveAccount interface required by the SDK.
 * Provides access to user addresses and encryption keys.
 */

import { importPrivateKey, importPublicKey } from './crypto.js';
import { authenticatedApiRequest } from './httpClient.js';

/**
 * Create an account provider for the Proton Drive SDK
 * 
 * @param {ProtonSession} session - Authenticated session with decrypted keys
 * @returns {Object} Account provider implementing ProtonDriveAccount interface
 */
export function createProtonAccount(session) {
    // Cache for decrypted keys
    const keyCache = new Map();
    
    /**
     * Get the primary address
     */
    function getPrimaryAddress() {
        if (!session.addresses || session.addresses.length === 0) {
            throw new Error('No addresses available');
        }
        
        // Find the primary address (Order = 1, or first enabled address)
        const primary = session.addresses.find(a => a.Order === 1) || 
                       session.addresses.find(a => a.Status === 1) ||
                       session.addresses[0];
        
        return primary;
    }
    
    /**
     * Get decrypted keys for an address
     */
    async function getDecryptedKeysForAddress(address) {
        const cacheKey = address.ID;
        if (keyCache.has(cacheKey)) {
            return keyCache.get(cacheKey);
        }
        
        const decryptedKeys = [];
        const addressKeys = session.addressKeys?.[address.ID] || [];
        
        for (let i = 0; i < addressKeys.length; i++) {
            const key = addressKeys[i];
            decryptedKeys.push({
                id: key.ID,
                key: key.privateKey,
            });
        }
        
        keyCache.set(cacheKey, decryptedKeys);
        return decryptedKeys;
    }
    
    /**
     * Find the primary key index
     */
    function findPrimaryKeyIndex(keys) {
        const primaryIndex = keys.findIndex(k => k.Primary === 1);
        return primaryIndex >= 0 ? primaryIndex : 0;
    }
    
    return {
        /**
         * Get the user's primary address with decrypted keys
         */
        async getOwnPrimaryAddress() {
            const address = getPrimaryAddress();
            const keys = await getDecryptedKeysForAddress(address);
            const addressKeys = session.addressKeys?.[address.ID] || address.Keys || [];
            
            return {
                email: address.Email,
                addressId: address.ID,
                primaryKeyIndex: findPrimaryKeyIndex(addressKeys),
                keys,
            };
        },
        
        /**
         * Get a specific address by email or ID
         */
        async getOwnAddress(emailOrAddressId) {
            if (!session.addresses) {
                throw new Error('No addresses available');
            }
            
            const address = session.addresses.find(
                a => a.Email === emailOrAddressId || a.ID === emailOrAddressId
            );
            
            if (!address) {
                throw new Error(`Address not found: ${emailOrAddressId}`);
            }
            
            const keys = await getDecryptedKeysForAddress(address);
            const addressKeys = session.addressKeys?.[address.ID] || address.Keys || [];
            
            return {
                email: address.Email,
                addressId: address.ID,
                primaryKeyIndex: findPrimaryKeyIndex(addressKeys),
                keys,
            };
        },
        
        /**
         * Check if an email belongs to a Proton account
         */
        async hasProtonAccount(email) {
            try {
                // Query the API to check if the email is a Proton account
                const response = await authenticatedApiRequest(session, 'core/v4/keys', {
                    method: 'GET',
                    params: { Email: email },
                });
                return response.Keys && response.Keys.length > 0;
            } catch (error) {
                return false;
            }
        },
        
        /**
         * Get public keys for an email address
         */
        async getPublicKeys(email) {
            try {
                const response = await authenticatedApiRequest(session, `core/v4/keys?Email=${encodeURIComponent(email)}`);
                
                const publicKeys = [];
                for (const key of response.Keys || []) {
                    if (key.PublicKey) {
                        const publicKey = await importPublicKey(key.PublicKey);
                        publicKeys.push(publicKey);
                    }
                }
                
                return publicKeys;
            } catch (error) {
                console.error(`Failed to get public keys for ${email}:`, error);
                return [];
            }
        },
    };
}
