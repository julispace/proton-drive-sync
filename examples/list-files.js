#!/usr/bin/env node

/**
 * Proton Drive - List All Files CLI
 * 
 * Lists all files in your Proton Drive including My Files, Shared, and Trash.
 * 
 * Usage:
 *   node list-files.js [options]
 */

import * as readline from 'readline';
import { ProtonAuth, createProtonHttpClient, createProtonAccount, initCrypto } from './auth/index.js';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);

const options = {
    help: args.includes('--help') || args.includes('-h'),
    myFiles: !args.includes('--no-my-files'),
    shared: !args.includes('--no-shared'),
    trash: !args.includes('--no-trash'),
    json: args.includes('--json'),
    username: getArgValue('--username') || getArgValue('-u'),
    password: getArgValue('--password') || getArgValue('-p'),
};

function getArgValue(flag) {
    const index = args.indexOf(flag);
    if (index !== -1 && args[index + 1]) {
        return args[index + 1];
    }
    return null;
}

if (options.help) {
    console.log(`
Proton Drive - List All Files

Usage:
  node list-files.js [options]

Options:
  -h, --help              Show this help message
  -u, --username <user>   Proton username (will prompt if not provided)
  -p, --password <pass>   Password (will prompt if not provided)
  --no-my-files           Skip listing files in "My Files"
  --no-shared             Skip listing shared files
  --no-trash              Skip listing trashed files
  --json                  Output as JSON instead of formatted text

Examples:
  node list-files.js                          # Interactive login
  node list-files.js -u myuser                # Provide username, prompt for password
  node list-files.js --no-trash               # List files except trash
  node list-files.js --json                   # Output as JSON

Security Note:
  Avoid passing password via command line in production.
  The interactive prompt is more secure.
`);
    process.exit(0);
}

// ============================================================================
// Interactive Prompt
// ============================================================================

async function prompt(question, hidden = false) {
    // For non-hidden prompts, use readline normally
    if (!hidden) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        
        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }
    
    // For hidden input (password), handle manually
    return new Promise((resolve) => {
        process.stdout.write(question);
        let password = '';
        
        // Check if we can use raw mode (TTY only)
        if (!process.stdin.isTTY) {
            // Fallback for non-TTY: use readline (password will be visible)
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.question('', (answer) => {
                rl.close();
                resolve(answer);
            });
            return;
        }
        
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        
        const onData = (char) => {
            char = char.toString();
            
            switch (char) {
                case '\n':
                case '\r':
                case '\u0004': // Ctrl+D
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    resolve(password);
                    break;
                case '\u0003': // Ctrl+C
                    process.stdin.setRawMode(false);
                    process.stdout.write('\n');
                    process.exit(0);
                    break;
                case '\u007F': // Backspace (macOS/Linux)
                case '\b':     // Backspace (Windows)
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                        // Optionally show backspace effect with asterisks
                        // process.stdout.write('\b \b');
                    }
                    break;
                default:
                    // Only add printable characters
                    if (char.charCodeAt(0) >= 32) {
                        password += char;
                        // Optionally show asterisk for each character
                        // process.stdout.write('*');
                    }
                    break;
            }
        };
        
        process.stdin.on('data', onData);
    });
}

// ============================================================================
// File Listing Functions
// ============================================================================

/**
 * Collects all files recursively from a folder
 */
async function collectFilesRecursively(client, folderUid, path = '', signal) {
    const results = [];
    
    for await (const node of client.iterateFolderChildren(folderUid, signal)) {
        if (!node.ok) {
            results.push({
                type: 'degraded',
                path: path ? `${path}/<unable to decrypt>` : '<unable to decrypt>',
                error: 'Decryption failed',
            });
            continue;
        }

        const nodeData = node.data;
        const fullPath = path ? `${path}/${nodeData.name}` : nodeData.name;

        if (nodeData.type === 'folder') {
            results.push({
                type: 'folder',
                name: nodeData.name,
                path: fullPath,
                uid: nodeData.uid,
                createdAt: nodeData.creationTime?.toISOString() ?? null,
                isShared: nodeData.isShared,
            });
            
            const children = await collectFilesRecursively(client, nodeData.uid, fullPath, signal);
            results.push(...children);
        } else {
            results.push({
                type: 'file',
                name: nodeData.name,
                path: fullPath,
                uid: nodeData.uid,
                size: nodeData.activeRevision?.claimedSize ?? null,
                mimeType: nodeData.mimeType ?? null,
                modifiedAt: nodeData.activeRevision?.claimedModificationTime?.toISOString() ?? null,
                createdAt: nodeData.creationTime?.toISOString() ?? null,
                isShared: nodeData.isShared,
            });
        }
    }
    
    return results;
}

/**
 * Format bytes to human readable size
 */
function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes === null) return 'unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Print files in formatted text output
 */
function printFormatted(section, files) {
    console.log(`\n=== ${section} ===\n`);
    
    if (files.length === 0) {
        console.log('  (empty)');
        return;
    }
    
    for (const file of files) {
        if (file.type === 'degraded') {
            console.log(`[DEGRADED] ${file.path}`);
        } else if (file.type === 'folder') {
            console.log(`[FOLDER]   ${file.path}/`);
        } else {
            const size = formatSize(file.size);
            const modified = file.modifiedAt ?? 'unknown';
            console.log(`[FILE]     ${file.path} (${size}, modified: ${modified})`);
        }
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    try {
        // Initialize crypto
        await initCrypto();
        
        // Get credentials
        const username = options.username || await prompt('Proton username: ');
        const password = options.password || await prompt('Password: ', true);
        
        if (!username || !password) {
            console.error('Username and password are required.');
            process.exit(1);
        }
        
        // Authenticate
        console.log('\nAuthenticating with Proton...');
        const auth = new ProtonAuth();
        
        let session;
        try {
            session = await auth.login(username, password);
        } catch (error) {
            if (error.requires2FA) {
                const code = await prompt('Enter 2FA code: ');
                await auth.submit2FA(code);
                session = auth.getSession();
                
                // Complete the session setup
                await auth.fetchUserData();
            } else {
                throw error;
            }
        }
        
        console.log(`Logged in as: ${session.user?.Name || username}\n`);
        
        // Load the SDK
        let ProtonDriveClient, MemoryCache;
        try {
            const sdk = await import('@protontech/drive-sdk');
            ProtonDriveClient = sdk.ProtonDriveClient;
            MemoryCache = sdk.MemoryCache;
        } catch (error) {
            console.error('Error: Could not load @protontech/drive-sdk');
            console.error('Make sure the SDK is built: cd ../sdk/js/sdk && pnpm build');
            console.error('Original error:', error.message);
            process.exit(1);
        }
        
        // Create SDK dependencies
        const httpClient = createProtonHttpClient(session);
        const account = createProtonAccount(session);
        
        // Create a minimal SRP module (not needed for read operations)
        const srpModule = {
            getSrp: async () => { throw new Error('SRP not implemented'); },
            getSrpVerifier: async () => { throw new Error('SRP not implemented'); },
            computeKeyPassword: async () => { throw new Error('SRP not implemented'); },
        };
        
        // Create OpenPGP crypto module wrapper
        // This needs to wrap openpgp to match the SDK's expected interface
        const { openpgp } = await import('./auth/crypto.js');
        const openPGPCryptoModule = createOpenPGPCryptoWrapper(openpgp);
        
        // Create the Drive client
        const client = new ProtonDriveClient({
            httpClient,
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account,
            openPGPCryptoModule,
            srpModule,
        });

        const output = {
            myFiles: [],
            shared: [],
            trash: [],
        };

        // Get "My Files"
        if (options.myFiles) {
            console.log('Fetching My Files...');
            const rootFolder = await client.getMyFilesRootFolder();
            
            if (!rootFolder.ok) {
                console.error('Failed to get root folder:', rootFolder.error);
            } else {
                output.myFiles = await collectFilesRecursively(client, rootFolder.data.uid);
            }
        }
        
        // Get shared files
        if (options.shared) {
            console.log('Fetching shared files...');
            for await (const node of client.iterateSharedNodesWithMe()) {
                if (!node.ok) {
                    output.shared.push({
                        type: 'degraded',
                        path: '<unable to decrypt>',
                        error: 'Decryption failed',
                    });
                    continue;
                }
                
                const nodeData = node.data;
                
                if (nodeData.type === 'folder') {
                    output.shared.push({
                        type: 'folder',
                        name: nodeData.name,
                        path: nodeData.name,
                        uid: nodeData.uid,
                    });
                    
                    const children = await collectFilesRecursively(client, nodeData.uid, nodeData.name);
                    output.shared.push(...children);
                } else {
                    output.shared.push({
                        type: 'file',
                        name: nodeData.name,
                        path: nodeData.name,
                        uid: nodeData.uid,
                        size: nodeData.activeRevision?.claimedSize ?? null,
                        modifiedAt: nodeData.activeRevision?.claimedModificationTime?.toISOString() ?? null,
                    });
                }
            }
        }
        
        // Get trashed files
        if (options.trash) {
            console.log('Fetching trash...');
            for await (const node of client.iterateTrashedNodes()) {
                if (!node.ok) {
                    output.trash.push({
                        type: 'degraded',
                        path: '<unable to decrypt>',
                        error: 'Decryption failed',
                    });
                    continue;
                }
                
                const nodeData = node.data;
                output.trash.push({
                    type: nodeData.type,
                    name: nodeData.name,
                    path: nodeData.name,
                    uid: nodeData.uid,
                    trashedAt: nodeData.trashTime?.toISOString() ?? null,
                });
            }
        }

        // Output results
        if (options.json) {
            console.log(JSON.stringify(output, null, 2));
        } else {
            console.log('\nProton Drive Files');
            console.log('==================');
            
            if (options.myFiles) {
                printFormatted('My Files', output.myFiles);
            }
            if (options.shared) {
                printFormatted('Shared with me', output.shared);
            }
            if (options.trash) {
                printFormatted('Trash', output.trash);
            }
            
            // Summary
            const totalFiles = output.myFiles.filter(f => f.type === 'file').length +
                              output.shared.filter(f => f.type === 'file').length;
            const totalFolders = output.myFiles.filter(f => f.type === 'folder').length +
                                output.shared.filter(f => f.type === 'folder').length;
            const totalTrashed = output.trash.length;
            
            console.log('\n---');
            console.log(`Total: ${totalFiles} files, ${totalFolders} folders, ${totalTrashed} trashed items`);
        }

        // Logout
        await auth.logout();
        
    } catch (error) {
        console.error('\nError:', error.message);
        if (error.code) {
            console.error('Error code:', error.code);
        }
        process.exit(1);
    }
}

/**
 * Create an OpenPGP crypto wrapper that matches the SDK's OpenPGPCrypto interface
 */
function createOpenPGPCryptoWrapper(openpgp) {
    const VERIFICATION_STATUS = {
        NOT_SIGNED: 0,
        SIGNED_AND_VALID: 1,
        SIGNED_AND_INVALID: 2,
    };
    
    const toArray = (val) => Array.isArray(val) ? val : [val];
    
    return {
        // Generate a random passphrase (32 bytes as base64)
        generatePassphrase() {
            const bytes = crypto.getRandomValues(new Uint8Array(32));
            return btoa(String.fromCharCode(...bytes));
        },
        
        async generateSessionKey(encryptionKeys) {
            return await openpgp.generateSessionKey({
                encryptionKeys: toArray(encryptionKeys),
            });
        },
        
        async encryptSessionKey(sessionKey, encryptionKeys) {
            const result = await openpgp.encryptSessionKey({
                data: sessionKey.data,
                algorithm: sessionKey.algorithm,
                encryptionKeys: toArray(encryptionKeys),
                format: 'binary',
            });
            return { keyPacket: result };
        },
        
        async encryptSessionKeyWithPassword(sessionKey, password) {
            const result = await openpgp.encryptSessionKey({
                data: sessionKey.data,
                algorithm: sessionKey.algorithm,
                passwords: [password],
                format: 'binary',
            });
            return { keyPacket: result };
        },
        
        async generateKey(passphrase) {
            const { privateKey, publicKey } = await openpgp.generateKey({
                type: 'ecc',
                curve: 'curve25519',
                userIDs: [{ name: 'Drive', email: 'drive@proton.me' }],
                passphrase,
                format: 'object',
            });
            const armoredKey = await openpgp.armor(privateKey);
            return { privateKey, armoredKey };
        },
        
        async encryptArmored(data, encryptionKeys, sessionKey) {
            const message = await openpgp.createMessage({ binary: data });
            const armoredData = await openpgp.encrypt({
                message,
                encryptionKeys: toArray(encryptionKeys),
                sessionKey,
                format: 'armored',
            });
            return { armoredData };
        },
        
        async encryptAndSign(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const encryptedData = await openpgp.encrypt({
                message,
                encryptionKeys: toArray(encryptionKeys),
                signingKeys: [signingKey],
                sessionKey,
                format: 'binary',
            });
            return { encryptedData };
        },
        
        async encryptAndSignArmored(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const armoredData = await openpgp.encrypt({
                message,
                encryptionKeys: toArray(encryptionKeys),
                signingKeys: [signingKey],
                sessionKey,
                format: 'armored',
            });
            return { armoredData };
        },
        
        async encryptAndSignDetached(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const [encryptedData, signatureResult] = await Promise.all([
                openpgp.encrypt({
                    message,
                    encryptionKeys: toArray(encryptionKeys),
                    sessionKey,
                    format: 'binary',
                }),
                openpgp.sign({
                    message,
                    signingKeys: [signingKey],
                    detached: true,
                    format: 'binary',
                }),
            ]);
            return { encryptedData, signature: signatureResult };
        },
        
        async encryptAndSignDetachedArmored(data, sessionKey, encryptionKeys, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const [armoredData, armoredSignature] = await Promise.all([
                openpgp.encrypt({
                    message,
                    encryptionKeys: toArray(encryptionKeys),
                    sessionKey,
                    format: 'armored',
                }),
                openpgp.sign({
                    message,
                    signingKeys: [signingKey],
                    detached: true,
                    format: 'armored',
                }),
            ]);
            return { armoredData, armoredSignature };
        },
        
        async sign(data, signingKey, signatureContext) {
            const message = await openpgp.createMessage({ binary: data });
            const signature = await openpgp.sign({
                message,
                signingKeys: [signingKey],
                detached: true,
                format: 'binary',
                context: signatureContext ? { value: signatureContext, critical: true } : undefined,
            });
            return { signature };
        },
        
        async signArmored(data, signingKey) {
            const message = await openpgp.createMessage({ binary: data });
            const signature = await openpgp.sign({
                message,
                signingKeys: toArray(signingKey),
                detached: true,
                format: 'armored',
            });
            return { signature };
        },
        
        async verify(data, signature, verificationKeys) {
            try {
                const message = await openpgp.createMessage({ binary: data });
                const sig = await openpgp.readSignature({ binarySignature: signature });
                const result = await openpgp.verify({
                    message,
                    signature: sig,
                    verificationKeys: toArray(verificationKeys),
                });
                
                const verified = await result.signatures[0]?.verified.catch(() => false);
                return {
                    verified: verified ? VERIFICATION_STATUS.SIGNED_AND_VALID : VERIFICATION_STATUS.SIGNED_AND_INVALID,
                };
            } catch (error) {
                return {
                    verified: VERIFICATION_STATUS.SIGNED_AND_INVALID,
                    verificationErrors: [error],
                };
            }
        },
        
        async verifyArmored(data, armoredSignature, verificationKeys, signatureContext) {
            try {
                const message = await openpgp.createMessage({ binary: data });
                const signature = await openpgp.readSignature({ armoredSignature });
                const result = await openpgp.verify({
                    message,
                    signature,
                    verificationKeys: toArray(verificationKeys),
                    context: signatureContext ? { value: signatureContext, required: true } : undefined,
                });
                
                const verified = await result.signatures[0]?.verified.catch(() => false);
                return {
                    verified: verified ? VERIFICATION_STATUS.SIGNED_AND_VALID : VERIFICATION_STATUS.SIGNED_AND_INVALID,
                };
            } catch (error) {
                return {
                    verified: VERIFICATION_STATUS.SIGNED_AND_INVALID,
                    verificationErrors: [error],
                };
            }
        },
        
        async decryptSessionKey(data, decryptionKeys) {
            const message = await openpgp.readMessage({ binaryMessage: data });
            const result = await openpgp.decryptSessionKeys({
                message,
                decryptionKeys: toArray(decryptionKeys),
            });
            return result[0];
        },
        
        async decryptArmoredSessionKey(armoredData, decryptionKeys) {
            const message = await openpgp.readMessage({ armoredMessage: armoredData });
            const result = await openpgp.decryptSessionKeys({
                message,
                decryptionKeys: toArray(decryptionKeys),
            });
            return result[0];
        },
        
        async decryptKey(armoredKey, passphrase) {
            const privateKey = await openpgp.readPrivateKey({ armoredKey });
            return await openpgp.decryptKey({ privateKey, passphrase });
        },
        
        async decryptAndVerify(data, sessionKey, verificationKeys) {
            try {
                const message = await openpgp.readMessage({ binaryMessage: data });
                const result = await openpgp.decrypt({
                    message,
                    sessionKeys: [sessionKey],
                    verificationKeys: toArray(verificationKeys),
                    format: 'binary',
                });
                
                let verified = VERIFICATION_STATUS.NOT_SIGNED;
                if (result.signatures?.length > 0) {
                    const sigVerified = await result.signatures[0].verified.catch(() => false);
                    verified = sigVerified ? VERIFICATION_STATUS.SIGNED_AND_VALID : VERIFICATION_STATUS.SIGNED_AND_INVALID;
                }
                
                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },
        
        async decryptAndVerifyDetached(data, signature, sessionKey, verificationKeys) {
            try {
                const message = await openpgp.readMessage({ binaryMessage: data });
                const result = await openpgp.decrypt({
                    message,
                    sessionKeys: [sessionKey],
                    format: 'binary',
                });
                
                let verified = VERIFICATION_STATUS.NOT_SIGNED;
                if (signature && verificationKeys) {
                    const sig = await openpgp.readSignature({ binarySignature: signature });
                    const verifyResult = await openpgp.verify({
                        message: await openpgp.createMessage({ binary: result.data }),
                        signature: sig,
                        verificationKeys: toArray(verificationKeys),
                    });
                    const sigVerified = await verifyResult.signatures[0]?.verified.catch(() => false);
                    verified = sigVerified ? VERIFICATION_STATUS.SIGNED_AND_VALID : VERIFICATION_STATUS.SIGNED_AND_INVALID;
                }
                
                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },
        
        async decryptArmored(armoredData, decryptionKeys) {
            const message = await openpgp.readMessage({ armoredMessage: armoredData });
            const result = await openpgp.decrypt({
                message,
                decryptionKeys: toArray(decryptionKeys),
                format: 'binary',
            });
            return result.data;
        },
        
        async decryptArmoredAndVerify(armoredData, decryptionKeys, verificationKeys) {
            try {
                const message = await openpgp.readMessage({ armoredMessage: armoredData });
                const result = await openpgp.decrypt({
                    message,
                    decryptionKeys: toArray(decryptionKeys),
                    verificationKeys: toArray(verificationKeys),
                    format: 'binary',
                });
                
                let verified = VERIFICATION_STATUS.NOT_SIGNED;
                if (result.signatures?.length > 0) {
                    const sigVerified = await result.signatures[0].verified.catch(() => false);
                    verified = sigVerified ? VERIFICATION_STATUS.SIGNED_AND_VALID : VERIFICATION_STATUS.SIGNED_AND_INVALID;
                }
                
                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },
        
        async decryptArmoredAndVerifyDetached(armoredData, armoredSignature, sessionKey, verificationKeys) {
            try {
                const message = await openpgp.readMessage({ armoredMessage: armoredData });
                const result = await openpgp.decrypt({
                    message,
                    sessionKeys: [sessionKey],
                    format: 'binary',
                });
                
                let verified = VERIFICATION_STATUS.NOT_SIGNED;
                if (armoredSignature && verificationKeys) {
                    const signature = await openpgp.readSignature({ armoredSignature });
                    const verifyResult = await openpgp.verify({
                        message: await openpgp.createMessage({ binary: result.data }),
                        signature,
                        verificationKeys: toArray(verificationKeys),
                    });
                    const sigVerified = await verifyResult.signatures[0]?.verified.catch(() => false);
                    verified = sigVerified ? VERIFICATION_STATUS.SIGNED_AND_VALID : VERIFICATION_STATUS.SIGNED_AND_INVALID;
                }
                
                return { data: result.data, verified };
            } catch (error) {
                throw error;
            }
        },
        
        async decryptArmoredWithPassword(armoredData, password) {
            const message = await openpgp.readMessage({ armoredMessage: armoredData });
            const result = await openpgp.decrypt({
                message,
                passwords: [password],
                format: 'binary',
            });
            return result.data;
        },
    };
}

// Run
main();
