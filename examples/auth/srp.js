/**
 * SRP (Secure Remote Password) implementation for Proton authentication
 * 
 * Based on Proton's WebClients SRP implementation.
 */

import { hash as bcryptHash, encodeBase64 as bcryptEncodeBase64 } from 'bcryptjs';
import { sha512, importPublicKey, verifyCleartextMessage } from './crypto.js';

// Constants from Proton's SRP implementation
const SRP_LEN = 2048 / 8; // 256 bytes
const BCRYPT_PREFIX = '$2y$10$';
const MAX_VALUE_ITERATIONS = 1000;

// Proton's SRP modulus public key for verification
const SRP_MODULUS_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

xjMEXAHLgxYJKwYBBAHaRw8BAQdAFurWXXwjTemqjD7CXjXVyKf0of7n9Ctm
L8v9enkzggHNEnByb3RvbkBzcnAubW9kdWx1c8J3BBAWCgApBQJcAcuDBgsJ
BwgDAgkQNQWFxOlRjyYEFQgKAgMWAgECGQECGwMCHgEAAPGRAP9sauJsW12U
MnTQUZpsbJb53d0Wv55mZIIiJL2XulpWPQD/V6NglBd96lZKBmInSXX/kXat
Sv+y0io+LR8i2+jV+AbOOARcAcuDEgorBgEEAZdVAQUBAQdAeJHUz1c9+KfE
kSIgcBRE3WuXC4oj5a2/U3oASExGDW4DAQgHwmEEGBYIABMFAlwBy4MJEDUF
hcTpUY8mAhsMAAD/XQD8DxNI6E78meodQI+wLsrKLeHn32iLvUqJbVDhfWSU
WO4BAMcm1u02t4VKw++ttECPt+HUgPUq5pqQWe5Q2cW4TMsE
=Y4Mw
-----END PGP PUBLIC KEY BLOCK-----`;

/**
 * Convert a Uint8Array to a BigInt (little-endian)
 */
function uint8ArrayToBigInt(arr) {
    let result = BigInt(0);
    for (let i = arr.length - 1; i >= 0; i--) {
        result = (result << BigInt(8)) | BigInt(arr[i]);
    }
    return result;
}

/**
 * Convert a BigInt to a Uint8Array (little-endian)
 */
function bigIntToUint8Array(num, length) {
    const arr = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        arr[i] = Number(num & BigInt(0xff));
        num = num >> BigInt(8);
    }
    return arr;
}

/**
 * Get the byte length of a BigInt
 */
function bigIntByteLength(num) {
    if (num === BigInt(0)) return 1;
    let length = 0;
    let temp = num;
    while (temp > BigInt(0)) {
        length++;
        temp = temp >> BigInt(8);
    }
    return length;
}

/**
 * Modular exponentiation: (base^exp) mod mod
 */
function modExp(base, exp, mod) {
    let result = BigInt(1);
    base = base % mod;
    while (exp > BigInt(0)) {
        if (exp % BigInt(2) === BigInt(1)) {
            result = (result * base) % mod;
        }
        exp = exp >> BigInt(1);
        base = (base * base) % mod;
    }
    return result;
}

/**
 * Modulo operation that handles negative numbers correctly
 */
function mod(n, m) {
    return ((n % m) + m) % m;
}

/**
 * Expand a hash using SHA-512
 */
async function expandHash(input) {
    const promises = [];
    for (let i = 0; i < 4; i++) {
        const data = new Uint8Array(input.length + 1);
        data.set(input);
        data[input.length] = i;
        promises.push(sha512(data));
    }
    const hashes = await Promise.all(promises);
    const result = new Uint8Array(hashes.reduce((sum, h) => sum + h.length, 0));
    let offset = 0;
    for (const hash of hashes) {
        result.set(hash, offset);
        offset += hash.length;
    }
    return result;
}

/**
 * Hash password using bcrypt and expand
 */
async function formatHash(password, salt, modulus) {
    const hash = await new Promise((resolve, reject) => {
        bcryptHash(password, BCRYPT_PREFIX + salt, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
    
    const hashBytes = new TextEncoder().encode(hash);
    const combined = new Uint8Array(hashBytes.length + modulus.length);
    combined.set(hashBytes);
    combined.set(modulus, hashBytes.length);
    
    return expandHash(combined);
}

/**
 * Hash password for version 3/4 (current)
 */
async function hashPassword3(password, salt, modulus) {
    // Decode the base64 salt and append 'proton'
    const saltBytes = base64ToUint8Array(salt);
    const protonBytes = new TextEncoder().encode('proton');
    const saltBinary = new Uint8Array(saltBytes.length + protonBytes.length);
    saltBinary.set(saltBytes);
    saltBinary.set(protonBytes, saltBytes.length);
    
    // Re-encode as bcrypt base64 (16 bytes)
    const bcryptSalt = bcryptEncodeBase64(saltBinary, 16);
    
    return formatHash(password, bcryptSalt, modulus);
}

/**
 * Hash password based on auth version
 */
export async function hashPassword({ password, salt, username, modulus, version }) {
    if (version === 4 || version === 3) {
        if (!salt) {
            throw new Error('Missing salt');
        }
        return hashPassword3(password, salt, modulus);
    }
    
    // For version 0-2, we'd need different handling
    // These are legacy and rarely used
    throw new Error(`Unsupported auth version: ${version}`);
}

/**
 * Base64 to Uint8Array (handles both standard and URL-safe base64)
 */
function base64ToUint8Array(base64) {
    // Handle URL-safe base64
    const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Uint8Array to base64
 */
function uint8ArrayToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Verify and get the modulus from the server's signed response
 */
export async function verifyAndGetModulus(signedModulus) {
    const publicKey = await importPublicKey(SRP_MODULUS_KEY);
    
    const { data: modulusData, verified } = await verifyCleartextMessage({
        armoredCleartextMessage: signedModulus,
        verificationKeys: [publicKey],
    });
    
    if (!verified) {
        throw new Error('Unable to verify server identity - modulus signature invalid');
    }
    
    return base64ToUint8Array(modulusData.trim());
}

/**
 * Generate random client secret
 */
function generateClientSecret(length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return uint8ArrayToBigInt(bytes);
}

/**
 * Generate SRP parameters
 */
async function generateParameters({ byteLength, generator, modulus, serverEphemeralArray }) {
    const clientSecret = generateClientSecret(byteLength);
    const clientEphemeral = modExp(generator, clientSecret, modulus);
    const clientEphemeralArray = bigIntToUint8Array(clientEphemeral, byteLength);
    
    const combined = new Uint8Array(clientEphemeralArray.length + serverEphemeralArray.length);
    combined.set(clientEphemeralArray);
    combined.set(serverEphemeralArray, clientEphemeralArray.length);
    
    const clientServerHash = await expandHash(combined);
    const scramblingParam = uint8ArrayToBigInt(clientServerHash);
    
    return {
        clientSecret,
        clientEphemeral,
        scramblingParam,
    };
}

/**
 * Get safe SRP parameters (loop until we find valid ones)
 */
async function getParameters({ byteLength, generator, modulus, serverEphemeralArray }) {
    for (let i = 0; i < MAX_VALUE_ITERATIONS; i++) {
        const { clientSecret, clientEphemeral, scramblingParam } = await generateParameters({
            byteLength,
            generator,
            modulus,
            serverEphemeralArray,
        });
        
        if (scramblingParam !== BigInt(0) && clientEphemeral !== BigInt(0)) {
            return { clientSecret, clientEphemeral, scramblingParam };
        }
    }
    throw new Error('Could not find safe SRP parameters');
}

/**
 * Generate SRP proofs
 */
async function generateProofs({ byteLength, modulusArray, hashedPasswordArray, serverEphemeralArray }) {
    const modulus = uint8ArrayToBigInt(modulusArray);
    if (bigIntByteLength(modulus) !== byteLength) {
        throw new Error('SRP modulus has incorrect size');
    }
    
    const generator = BigInt(2);
    
    // Calculate multiplier k = H(g, N)
    const generatorArray = bigIntToUint8Array(generator, byteLength);
    const combined = new Uint8Array(byteLength + modulusArray.length);
    combined.set(generatorArray);
    combined.set(modulusArray, byteLength);
    const hashedArray = await expandHash(combined);
    
    const multiplier = uint8ArrayToBigInt(hashedArray);
    const serverEphemeral = uint8ArrayToBigInt(serverEphemeralArray);
    const hashedPassword = uint8ArrayToBigInt(hashedPasswordArray);
    
    const modulusMinusOne = modulus - BigInt(1);
    const multiplierReduced = mod(multiplier, modulus);
    
    if (serverEphemeral === BigInt(0)) {
        throw new Error('SRP server ephemeral is out of bounds');
    }
    
    const { clientSecret, clientEphemeral, scramblingParam } = await getParameters({
        byteLength,
        generator,
        modulus,
        serverEphemeralArray,
    });
    
    // Calculate shared session key
    const kgx = mod(modExp(generator, hashedPassword, modulus) * multiplierReduced, modulus);
    const sharedSessionKeyExponent = mod(scramblingParam * hashedPassword + clientSecret, modulusMinusOne);
    const sharedSessionKeyBase = mod(serverEphemeral - kgx, modulus);
    const sharedSessionKey = modExp(sharedSessionKeyBase, sharedSessionKeyExponent, modulus);
    
    const clientEphemeralArray = bigIntToUint8Array(clientEphemeral, byteLength);
    const sharedSessionArray = bigIntToUint8Array(sharedSessionKey, byteLength);
    
    // Calculate proofs
    const proofInput = new Uint8Array(byteLength * 3);
    proofInput.set(clientEphemeralArray);
    proofInput.set(serverEphemeralArray, byteLength);
    proofInput.set(sharedSessionArray, byteLength * 2);
    const clientProof = await expandHash(proofInput);
    
    const serverProofInput = new Uint8Array(byteLength + clientProof.length + byteLength);
    serverProofInput.set(clientEphemeralArray);
    serverProofInput.set(clientProof, byteLength);
    serverProofInput.set(sharedSessionArray, byteLength + clientProof.length);
    const expectedServerProof = await expandHash(serverProofInput);
    
    return {
        clientEphemeral: clientEphemeralArray,
        clientProof,
        expectedServerProof,
        sharedSession: sharedSessionArray,
    };
}

/**
 * Perform SRP authentication
 * 
 * @param {Object} authInfo - Server auth info response
 * @param {Object} credentials - User credentials { username, password }
 * @param {number} [authVersion] - Optional auth version override
 * @returns {Object} SRP auth data for the server
 */
export async function getSrp(authInfo, credentials, authVersion) {
    const { Modulus: serverModulus, ServerEphemeral, Salt, Version } = authInfo;
    const { password } = credentials;
    const version = authVersion ?? Version;
    
    // Verify and extract the modulus
    const modulusArray = await verifyAndGetModulus(serverModulus);
    const serverEphemeralArray = base64ToUint8Array(ServerEphemeral);
    
    // Hash the password
    const hashedPasswordArray = await hashPassword({
        version,
        password,
        salt: version >= 3 ? Salt : undefined,
        username: version < 3 ? authInfo.Username : undefined,
        modulus: modulusArray,
    });
    
    // Generate proofs
    const { clientEphemeral, clientProof, expectedServerProof, sharedSession } = await generateProofs({
        byteLength: SRP_LEN,
        modulusArray,
        hashedPasswordArray,
        serverEphemeralArray,
    });
    
    return {
        clientEphemeral: uint8ArrayToBase64(clientEphemeral),
        clientProof: uint8ArrayToBase64(clientProof),
        expectedServerProof: uint8ArrayToBase64(expectedServerProof),
        sharedSession,
    };
}

/**
 * Compute key password from user password and salt
 * Used to decrypt user's private keys
 */
export async function computeKeyPassword(password, salt) {
    if (!password || !salt || salt.length !== 24 || password.length < 1) {
        throw new Error('Password and salt required.');
    }
    
    const saltBinary = base64ToUint8Array(salt);
    const bcryptSalt = bcryptEncodeBase64(saltBinary, 16);
    
    const hash = await new Promise((resolve, reject) => {
        bcryptHash(password, BCRYPT_PREFIX + bcryptSalt, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
    
    // Remove bcrypt prefix and salt (first 29 characters)
    return hash.slice(29);
}
