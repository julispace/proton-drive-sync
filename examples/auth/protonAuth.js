/**
 * Proton Authentication
 * 
 * Main authentication class that handles the complete login flow.
 */

import { getSrp, computeKeyPassword } from './srp.js';
import { ProtonSession } from './session.js';
import { apiRequest, authenticatedApiRequest } from './httpClient.js';
import { importPrivateKey } from './crypto.js';

/**
 * Proton Authentication handler
 */
export class ProtonAuth {
    constructor() {
        this.session = null;
    }
    
    /**
     * Login with username and password
     * 
     * @param {string} username - Proton username (without @proton.me)
     * @param {string} password - Account password
     * @param {Object} options - Additional options
     * @param {string} options.twoFactorCode - TOTP code if 2FA is enabled
     * @returns {ProtonSession} Authenticated session
     */
    async login(username, password, options = {}) {
        console.log('Starting authentication...');
        
        // Step 1: Get auth info (SRP parameters)
        console.log('Getting auth info...');
        const authInfo = await apiRequest('core/v4/auth/info', {
            method: 'POST',
            data: { Username: username },
        });
        
        // Step 2: Perform SRP authentication
        console.log('Performing SRP authentication...');
        const srpData = await getSrp(authInfo, { username, password });
        
        // Step 3: Send auth request
        console.log('Authenticating...');
        const authData = {
            Username: username,
            ClientProof: srpData.clientProof,
            ClientEphemeral: srpData.clientEphemeral,
            SRPSession: authInfo.SRPSession,
            PersistentCookies: 0,
        };
        
        // Add 2FA code if provided
        if (options.twoFactorCode) {
            authData.TwoFactorCode = options.twoFactorCode;
        }
        
        const authResponse = await apiRequest('core/v4/auth', {
            method: 'POST',
            data: authData,
        });
        
        // Verify server proof
        if (authResponse.ServerProof !== srpData.expectedServerProof) {
            throw new Error('Server proof verification failed - possible MITM attack');
        }
        
        // Create session
        this.session = new ProtonSession(authResponse);
        
        // Check if 2FA is required
        if (this.session.requires2FA() && !options.twoFactorCode) {
            const methods = [];
            if (this.session.hasTOTP()) methods.push('TOTP');
            if (this.session.hasFIDO2()) methods.push('FIDO2');
            
            const error = new Error(`Two-factor authentication required. Methods: ${methods.join(', ')}`);
            error.requires2FA = true;
            error.methods = methods;
            error.session = this.session;
            throw error;
        }
        
        // Step 4: Get key salts and compute key password
        console.log('Decrypting user keys...');
        const saltsResponse = await authenticatedApiRequest(this.session, 'core/v4/keys/salts');
        const primaryKeySalt = saltsResponse.KeySalts?.find(s => s.Primary === 1) || saltsResponse.KeySalts?.[0];
        
        if (!primaryKeySalt?.KeySalt) {
            throw new Error('Could not get key salt from server');
        }
        
        await this.unlockSession(password, primaryKeySalt.KeySalt);
        
        // Step 5: Fetch user data and addresses
        console.log('Fetching user data...');
        await this.fetchUserData();
        
        console.log('Authentication successful!');
        return this.session;
    }
    
    /**
     * Complete 2FA authentication
     * 
     * @param {string} code - TOTP code
     */
    async submit2FA(code) {
        if (!this.session) {
            throw new Error('No session - call login() first');
        }
        
        const response = await authenticatedApiRequest(this.session, 'core/v4/auth/2fa', {
            method: 'POST',
            data: { TwoFactorCode: code },
        });
        
        // Update session with any new tokens
        if (response.AccessToken) {
            this.session.accessToken = response.AccessToken;
        }
        
        return this.session;
    }
    
    /**
     * Unlock the session by decrypting user keys
     */
    async unlockSession(password, salt) {
        // Compute the key password
        this.session.keyPassword = await computeKeyPassword(password, salt);
    }
    
    /**
     * Fetch user data and addresses
     */
    async fetchUserData() {
        // Fetch user info
        const userResponse = await authenticatedApiRequest(this.session, 'core/v4/users');
        this.session.user = userResponse.User;
        
        // Fetch addresses
        const addressesResponse = await authenticatedApiRequest(this.session, 'core/v4/addresses');
        this.session.addresses = addressesResponse.Addresses;
        
        // Decrypt user keys
        await this.decryptUserKeys();
        
        // Decrypt address keys
        await this.decryptAddressKeys();
    }
    
    /**
     * Decrypt user's private keys
     */
    async decryptUserKeys() {
        if (!this.session.user?.Keys || !this.session.keyPassword) {
            return;
        }
        
        this.session.userKeys = [];
        
        for (const key of this.session.user.Keys) {
            try {
                const privateKey = await importPrivateKey(key.PrivateKey, this.session.keyPassword);
                this.session.userKeys.push({
                    ID: key.ID,
                    privateKey,
                    primary: key.Primary === 1,
                });
            } catch (error) {
                console.warn(`Failed to decrypt user key ${key.ID}:`, error.message);
            }
        }
    }
    
    /**
     * Decrypt address private keys
     */
    async decryptAddressKeys() {
        if (!this.session.addresses || !this.session.userKeys?.length) {
            return;
        }
        
        this.session.addressKeys = {};
        
        for (const address of this.session.addresses) {
            this.session.addressKeys[address.ID] = [];
            
            for (const key of address.Keys || []) {
                try {
                    // Address keys are encrypted with user keys
                    // For simplicity, try decrypting with key password first
                    // In a full implementation, we'd need to decrypt the token
                    const privateKey = await this.decryptAddressKey(key);
                    if (privateKey) {
                        this.session.addressKeys[address.ID].push({
                            ID: key.ID,
                            privateKey,
                            primary: key.Primary === 1,
                        });
                    }
                } catch (error) {
                    console.warn(`Failed to decrypt address key ${key.ID}:`, error.message);
                }
            }
        }
    }
    
    /**
     * Decrypt a single address key
     */
    async decryptAddressKey(key) {
        // If the key has a Token, it needs to be decrypted with user keys
        if (key.Token && this.session.userKeys?.length) {
            // Decrypt the token using user keys
            const token = await this.decryptMemberToken(key.Token);
            if (token) {
                return await importPrivateKey(key.PrivateKey, token);
            }
        }
        
        // Fallback: try with key password directly
        try {
            return await importPrivateKey(key.PrivateKey, this.session.keyPassword);
        } catch {
            return null;
        }
    }
    
    /**
     * Decrypt a member token using user keys
     */
    async decryptMemberToken(armoredToken) {
        if (!this.session.userKeys?.length) {
            return null;
        }
        
        try {
            const { openpgp } = await import('./crypto.js');
            
            const message = await openpgp.readMessage({ armoredMessage: armoredToken });
            const privateKeys = this.session.userKeys.map(k => k.privateKey);
            
            const result = await openpgp.decrypt({
                message,
                decryptionKeys: privateKeys,
            });
            
            return result.data;
        } catch (error) {
            console.warn('Failed to decrypt member token:', error.message);
            return null;
        }
    }
    
    /**
     * Refresh the access token
     */
    async refreshToken() {
        if (!this.session?.refreshToken) {
            throw new Error('No refresh token available');
        }
        
        const response = await apiRequest('auth/refresh', {
            method: 'POST',
            headers: {
                'x-pm-uid': this.session.uid,
            },
            data: {
                ResponseType: 'token',
                GrantType: 'refresh_token',
                RefreshToken: this.session.refreshToken,
                RedirectURI: 'https://protonmail.com',
            },
        });
        
        this.session.accessToken = response.AccessToken;
        this.session.refreshToken = response.RefreshToken;
        this.session.expiresIn = response.ExpiresIn;
        
        return this.session;
    }
    
    /**
     * Logout and invalidate the session
     */
    async logout() {
        if (!this.session) {
            return;
        }
        
        try {
            await authenticatedApiRequest(this.session, 'core/v4/auth', {
                method: 'DELETE',
            });
        } catch (error) {
            console.warn('Logout request failed:', error.message);
        }
        
        this.session = null;
    }
    
    /**
     * Get the current session
     */
    getSession() {
        return this.session;
    }
}
