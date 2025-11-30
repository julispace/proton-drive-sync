#!/usr/bin/env node

/**
 * Proton Drive - List All Files
 *
 * Lists all files in your Proton Drive.
 */

import { input, password, confirm } from '@inquirer/prompts';
// @ts-expect-error - keychain doesn't have type definitions
import keychain from 'keychain';
import { promisify } from 'util';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';

// ============================================================================
// Types
// ============================================================================

interface FileEntry {
    type: 'file' | 'folder' | 'degraded';
    path: string;
    size?: number | null;
}

interface NodeData {
    name: string;
    uid: string;
    type: string; // 'file' | 'folder' or other NodeType values
    activeRevision?: {
        claimedSize?: number;
    };
}

interface NodeResult {
    ok: boolean;
    value?: NodeData;
    error?: unknown;
}

interface RootFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

interface ProtonDriveClientType {
    iterateFolderChildren(folderUid: string): AsyncIterable<NodeResult>;
    getMyFilesRootFolder(): Promise<RootFolderResult>;
}

interface StoredCredentials {
    username: string;
    password: string;
}

interface ApiError extends Error {
    requires2FA?: boolean;
    code?: number;
}

// ============================================================================
// Keychain Helpers (uses macOS Keychain via security CLI)
// ============================================================================

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT_PREFIX = 'proton-drive-sync:';

// Promisify keychain methods
const keychainGetPassword = promisify(keychain.getPassword).bind(keychain);
const keychainSetPassword = promisify(keychain.setPassword).bind(keychain);
const keychainDeletePassword = promisify(keychain.deletePassword).bind(keychain);

async function getStoredCredentials(): Promise<StoredCredentials | null> {
    try {
        // First, try to get the stored username
        const username = await keychainGetPassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
            service: KEYCHAIN_SERVICE,
        });

        // Then get the password for that user
        const pwd = await keychainGetPassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
            service: KEYCHAIN_SERVICE,
        });

        return { username, password: pwd };
    } catch {
        return null;
    }
}

async function storeCredentials(username: string, pwd: string): Promise<void> {
    // Store username
    await keychainSetPassword({
        account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
        service: KEYCHAIN_SERVICE,
        password: username,
    });

    // Store password
    await keychainSetPassword({
        account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
        service: KEYCHAIN_SERVICE,
        password: pwd,
    });
}

async function deleteStoredCredentials(): Promise<void> {
    try {
        await keychainDeletePassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
            service: KEYCHAIN_SERVICE,
        });
    } catch {
        // Ignore errors
    }

    try {
        await keychainDeletePassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
            service: KEYCHAIN_SERVICE,
        });
    } catch {
        // Ignore errors
    }
}

// ============================================================================
// File Listing
// ============================================================================

async function collectFilesRecursively(
    client: ProtonDriveClientType,
    folderUid: string,
    path: string = ''
): Promise<FileEntry[]> {
    const results: FileEntry[] = [];

    for await (const node of client.iterateFolderChildren(folderUid)) {
        if (!node.ok) {
            results.push({
                type: 'degraded',
                path: path ? `${path}/<unable to decrypt>` : '<unable to decrypt>',
            });
            continue;
        }

        const nodeData = node.value!;
        const fullPath = path ? `${path}/${nodeData.name}` : nodeData.name;

        if (nodeData.type === 'folder') {
            results.push({ type: 'folder', path: fullPath });
            const children = await collectFilesRecursively(client, nodeData.uid, fullPath);
            results.push(...children);
        } else {
            results.push({
                type: 'file',
                path: fullPath,
                size: nodeData.activeRevision?.claimedSize ?? null,
            });
        }
    }

    return results;
}

function formatSize(bytes: number | null | undefined): string {
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

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    try {
        await initCrypto();

        let username: string;
        let pwd: string;

        // Check for stored credentials in Keychain
        const storedCreds = await getStoredCredentials();

        if (storedCreds) {
            console.log(`Found stored credentials for: ${storedCreds.username}`);
            const useStored = await confirm({
                message: 'Use stored credentials?',
                default: true,
            });

            if (useStored) {
                username = storedCreds.username;
                pwd = storedCreds.password;
            } else {
                // Ask if they want to enter new credentials
                username = await input({ message: 'Proton username:' });
                pwd = await password({ message: 'Password:' });
            }
        } else {
            username = await input({ message: 'Proton username:' });
            pwd = await password({ message: 'Password:' });
        }

        if (!username || !pwd) {
            console.error('Username and password are required.');
            process.exit(1);
        }

        // Offer to save credentials if they're new
        if (!storedCreds || storedCreds.username !== username || storedCreds.password !== pwd) {
            const saveToKeychain = await confirm({
                message: 'Save credentials to Keychain?',
                default: true,
            });

            if (saveToKeychain) {
                await deleteStoredCredentials(); // Remove old credentials first
                await storeCredentials(username, pwd);
                console.log('Credentials saved to Keychain.');
            }
        }

        console.log('\nAuthenticating with Proton...');
        const auth = new ProtonAuth();

        let session;
        try {
            session = await auth.login(username, pwd);
        } catch (error) {
            if ((error as ApiError).requires2FA) {
                const code = await input({ message: 'Enter 2FA code:' });
                await auth.submit2FA(code);
                session = auth.getSession();
            } else {
                throw error;
            }
        }

        console.log(`Logged in as: ${session?.user?.Name || username}\n`);

        // Load the SDK dynamically
        type SDKModule = typeof import('@protontech/drive-sdk');
        let sdk: SDKModule;
        try {
            sdk = await import('@protontech/drive-sdk');
        } catch {
            console.error('Error: Could not load @protontech/drive-sdk');
            console.error('Make sure the SDK is built: cd ../sdk/js/sdk && pnpm build');
            process.exit(1);
        }

        const httpClient = createProtonHttpClient(session!);
        const account = createProtonAccount(session!);
        const srpModuleInstance = createSrpModule();
        const openPGPCryptoModule = createOpenPGPCrypto();

        // Our local interfaces are runtime-compatible with the SDK's interfaces
        // but TypeScript sees them as different due to openpgp type re-exports
        const client: ProtonDriveClientType = new sdk.ProtonDriveClient({
            httpClient,
            entitiesCache: new sdk.MemoryCache(),
            cryptoCache: new sdk.MemoryCache(),
            // @ts-expect-error - PrivateKey types differ between openpgp imports
            account,
            // @ts-expect-error - PrivateKey types differ between openpgp imports
            openPGPCryptoModule,
            srpModule: srpModuleInstance,
        });

        console.log('Fetching files...');
        const rootFolder = await client.getMyFilesRootFolder();

        if (!rootFolder.ok) {
            console.error('Failed to get root folder:', rootFolder.error);
            process.exit(1);
        }

        const files = await collectFilesRecursively(client, rootFolder.value!.uid);

        console.log('\n=== My Files ===\n');

        if (files.length === 0) {
            console.log('  (empty)');
        } else {
            for (const file of files) {
                if (file.type === 'degraded') {
                    console.log(`[DEGRADED] ${file.path}`);
                } else if (file.type === 'folder') {
                    console.log(`[FOLDER]   ${file.path}/`);
                } else {
                    console.log(`[FILE]     ${file.path} (${formatSize(file.size)})`);
                }
            }
        }

        const totalFiles = files.filter((f) => f.type === 'file').length;
        const totalFolders = files.filter((f) => f.type === 'folder').length;

        console.log('\n---');
        console.log(`Total: ${totalFiles} files, ${totalFolders} folders`);

        await auth.logout();
    } catch (error) {
        console.error('\nError:', (error as Error).message);
        if ((error as ApiError).code) {
            console.error('Error code:', (error as ApiError).code);
        }
        process.exit(1);
    }
}

main();
