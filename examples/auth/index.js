/**
 * Proton Authentication Module
 * 
 * Provides authentication with Proton's API using SRP (Secure Remote Password).
 * This module handles the complete login flow and returns an authenticated session.
 */

export { ProtonAuth } from './protonAuth.js';
export { ProtonSession } from './session.js';
export { createProtonHttpClient } from './httpClient.js';
export { createProtonAccount } from './account.js';
export { initCrypto } from './crypto.js';
