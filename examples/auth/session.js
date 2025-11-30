/**
 * Proton Session Management
 * 
 * Stores and manages authentication session data.
 */

/**
 * Represents an authenticated Proton session
 */
export class ProtonSession {
    constructor(data) {
        this.uid = data.UID;
        this.accessToken = data.AccessToken;
        this.refreshToken = data.RefreshToken;
        this.userId = data.UserID;
        this.scopes = data.Scope?.split(' ') || [];
        this.expiresIn = data.ExpiresIn;
        this.tokenType = data.TokenType || 'Bearer';
        this.passwordMode = data.PasswordMode;
        this.twoFactor = data['2FA'];
        this.localId = data.LocalID;
        
        // Will be set after key decryption
        this.keyPassword = null;
        this.user = null;
        this.addresses = null;
        this.userKeys = null;
        this.addressKeys = null;
        
        this.createdAt = Date.now();
    }
    
    /**
     * Check if the session is valid
     */
    isValid() {
        return !!(this.uid && this.accessToken);
    }
    
    /**
     * Check if 2FA is required
     */
    requires2FA() {
        return !!(this.twoFactor?.Enabled);
    }
    
    /**
     * Check if TOTP is enabled
     */
    hasTOTP() {
        return !!(this.twoFactor?.TOTP);
    }
    
    /**
     * Check if FIDO2 is enabled
     */
    hasFIDO2() {
        return !!(this.twoFactor?.FIDO2);
    }
    
    /**
     * Get authorization header value
     */
    getAuthHeader() {
        return `${this.tokenType} ${this.accessToken}`;
    }
    
    /**
     * Export session data (for persistence)
     */
    toJSON() {
        return {
            uid: this.uid,
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            userId: this.userId,
            scopes: this.scopes,
            expiresIn: this.expiresIn,
            tokenType: this.tokenType,
            keyPassword: this.keyPassword,
            createdAt: this.createdAt,
        };
    }
    
    /**
     * Create session from exported data
     */
    static fromJSON(data) {
        const session = new ProtonSession({
            UID: data.uid,
            AccessToken: data.accessToken,
            RefreshToken: data.refreshToken,
            UserID: data.userId,
            Scope: data.scopes?.join(' '),
            ExpiresIn: data.expiresIn,
            TokenType: data.tokenType,
        });
        session.keyPassword = data.keyPassword;
        session.createdAt = data.createdAt;
        return session;
    }
}
