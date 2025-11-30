#!/usr/bin/env node

/**
 * Proton Drive - Upload File
 *
 * Uploads a local file to Proton Drive.
 * If the file path contains directories (e.g., my_files/lol/lol2.txt),
 * those directories will be created on the remote if they don't exist.
 * If a file with the same name exists, it will be overwritten with a new revision.
 */

import { createReadStream, statSync } from 'fs';
import { Readable } from 'stream';
import { basename, dirname } from 'path';
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

interface NodeData {
    name: string;
    uid: string;
    type: string;
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

interface UploadController {
    pause(): void;
    resume(): void;
    completion(): Promise<string>;
}

interface FileUploader {
    getAvailableName(): Promise<string>;
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

interface FileRevisionUploader {
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

interface UploadMetadata {
    mediaType: string;
    expectedSize: number;
    modificationTime?: Date;
}

interface CreateFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

interface ProtonDriveClientType {
    iterateFolderChildren(folderUid: string): AsyncIterable<NodeResult>;
    getMyFilesRootFolder(): Promise<RootFolderResult>;
    createFolder(
        parentNodeUid: string,
        name: string,
        modificationTime?: Date
    ): Promise<CreateFolderResult>;
    getFileUploader(
        parentFolderUid: string,
        name: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileUploader>;
    getFileRevisionUploader(
        nodeUid: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileRevisionUploader>;
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
// Keychain Helpers
// ============================================================================

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT_PREFIX = 'proton-drive-sync:';

const keychainGetPassword = promisify(keychain.getPassword).bind(keychain);
const keychainSetPassword = promisify(keychain.setPassword).bind(keychain);
const keychainDeletePassword = promisify(keychain.deletePassword).bind(keychain);

async function getStoredCredentials(): Promise<StoredCredentials | null> {
    try {
        const username = await keychainGetPassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
            service: KEYCHAIN_SERVICE,
        });
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
    await keychainSetPassword({
        account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
        service: KEYCHAIN_SERVICE,
        password: username,
    });
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
        // Ignore
    }
    try {
        await keychainDeletePassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
            service: KEYCHAIN_SERVICE,
        });
    } catch {
        // Ignore
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a Node.js Readable stream to a Web ReadableStream
 */
function nodeStreamToWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            nodeStream.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on('end', () => {
                controller.close();
            });
            nodeStream.on('error', (err) => {
                controller.error(err);
            });
        },
        cancel() {
            nodeStream.destroy();
        },
    });
}

/**
 * Find an existing file by name in a folder
 */
async function findFileByName(
    client: ProtonDriveClientType,
    folderUid: string,
    fileName: string
): Promise<string | null> {
    for await (const node of client.iterateFolderChildren(folderUid)) {
        if (node.ok && node.value?.name === fileName && node.value.type === 'file') {
            return node.value.uid;
        }
    }
    return null;
}

/**
 * Find a folder by name in a parent folder.
 * Returns the folder UID if found, null otherwise.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". The SDK only sets the
 * `isFolderChildrenLoaded` flag after full iteration. If we exit early, the
 * cache flag isn't set, and subsequent calls would hit the API again.
 */
async function findFolderByName(
    client: ProtonDriveClientType,
    parentFolderUid: string,
    folderName: string
): Promise<string | null> {
    let foundUid: string | null = null;
    for await (const node of client.iterateFolderChildren(parentFolderUid)) {
        if (
            !foundUid &&
            node.ok &&
            node.value?.type === 'folder' &&
            node.value.name === folderName
        ) {
            foundUid = node.value.uid;
        }
    }
    return foundUid;
}

/**
 * Get the remote path from a local file path.
 * If the path starts with my_files/, strip that prefix.
 * Returns the directory path (without the filename).
 */
function getRemoteDirPath(localFilePath: string): string[] {
    let relativePath = localFilePath;

    // Strip my_files/ prefix if present
    if (relativePath.startsWith('my_files/')) {
        relativePath = relativePath.slice('my_files/'.length);
    } else if (relativePath.startsWith('./my_files/')) {
        relativePath = relativePath.slice('./my_files/'.length);
    }

    // Get the directory part (without the filename)
    const dirPath = dirname(relativePath);

    // If there's no directory (file is at root), return empty array
    if (dirPath === '.' || dirPath === '') {
        return [];
    }

    // Split by / to get folder components
    return dirPath.split('/').filter((part) => part.length > 0);
}

/**
 * Ensure all directories in the path exist, creating them if necessary.
 * Returns the UID of the final (deepest) folder.
 *
 * This is O(d) API calls where d = path depth, which is unavoidable for tree traversal.
 * Each level uses early-exit when the folder is found.
 * Once we need to create a folder, all subsequent folders must be created (no more searching).
 */
async function ensureRemotePath(
    client: ProtonDriveClientType,
    rootFolderUid: string,
    pathParts: string[]
): Promise<string> {
    let currentFolderUid = rootFolderUid;
    let needToCreate = false;

    for (const folderName of pathParts) {
        if (needToCreate) {
            // Once we start creating, all subsequent folders need to be created
            console.log(`  Creating folder: ${folderName}`);
            const result = await client.createFolder(currentFolderUid, folderName);
            if (!result.ok) {
                throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
            }
            currentFolderUid = result.value!.uid;
        } else {
            // Search for existing folder (with early exit on match)
            const existingFolderUid = await findFolderByName(client, currentFolderUid, folderName);

            if (existingFolderUid) {
                console.log(`  Found existing folder: ${folderName}`);
                currentFolderUid = existingFolderUid;
            } else {
                // Folder doesn't exist, create it and all subsequent folders
                console.log(`  Creating folder: ${folderName}`);
                const result = await client.createFolder(currentFolderUid, folderName);
                if (!result.ok) {
                    throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
                }
                currentFolderUid = result.value!.uid;
                needToCreate = true; // All subsequent folders must be created
            }
        }
    }

    return currentFolderUid;
}

function formatSize(bytes: number): string {
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
    const localFilePath = process.argv[2] || './my_files/file-to-add.txt';

    // Check if file exists
    let fileStat;
    try {
        fileStat = statSync(localFilePath);
    } catch {
        console.error(`Error: File not found: ${localFilePath}`);
        process.exit(1);
    }

    const fileName = basename(localFilePath);
    const fileSize = fileStat.size;

    console.log(`Uploading: ${localFilePath}`);
    console.log(`  Name: ${fileName}`);
    console.log(`  Size: ${formatSize(fileSize)}`);
    console.log();

    try {
        await initCrypto();

        let username: string;
        let pwd: string;

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

        if (!storedCreds || storedCreds.username !== username || storedCreds.password !== pwd) {
            const saveToKeychain = await confirm({
                message: 'Save credentials to Keychain?',
                default: true,
            });

            if (saveToKeychain) {
                await deleteStoredCredentials();
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

        // Load the SDK
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
        const openPGPCryptoModule = createOpenPGPCrypto();
        const account = createProtonAccount(session!, openPGPCryptoModule);
        const srpModuleInstance = createSrpModule();

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

        // Get root folder
        console.log('Getting root folder...');
        const rootFolder = await client.getMyFilesRootFolder();

        if (!rootFolder.ok) {
            console.error('Failed to get root folder:', rootFolder.error);
            process.exit(1);
        }

        const rootFolderUid = rootFolder.value!.uid;

        // Parse the remote directory path and ensure it exists
        const remoteDirParts = getRemoteDirPath(localFilePath);
        let targetFolderUid = rootFolderUid;

        if (remoteDirParts.length > 0) {
            console.log(`Ensuring remote path exists: ${remoteDirParts.join('/')}`);
            targetFolderUid = await ensureRemotePath(client, rootFolderUid, remoteDirParts);
        }

        // Check if file already exists in the target folder
        console.log(`Checking if "${fileName}" already exists...`);
        const existingFileUid = await findFileByName(client, targetFolderUid, fileName);

        const metadata: UploadMetadata = {
            mediaType: 'application/octet-stream',
            expectedSize: fileSize,
            modificationTime: fileStat.mtime,
        };

        let uploadController: UploadController;

        if (existingFileUid) {
            console.log(`File exists, uploading new revision...`);

            const revisionUploader = await client.getFileRevisionUploader(
                existingFileUid,
                metadata
            );

            const nodeStream = createReadStream(localFilePath);
            const webStream = nodeStreamToWebStream(nodeStream);

            uploadController = await revisionUploader.writeStream(
                webStream,
                [],
                (uploadedBytes) => {
                    const percent = ((uploadedBytes / fileSize) * 100).toFixed(1);
                    process.stdout.write(
                        `\rUploading: ${formatSize(uploadedBytes)} / ${formatSize(fileSize)} (${percent}%)`
                    );
                }
            );
        } else {
            console.log(`File doesn't exist, creating new file...`);

            const fileUploader = await client.getFileUploader(targetFolderUid, fileName, metadata);

            const nodeStream = createReadStream(localFilePath);
            const webStream = nodeStreamToWebStream(nodeStream);

            uploadController = await fileUploader.writeStream(webStream, [], (uploadedBytes) => {
                const percent = ((uploadedBytes / fileSize) * 100).toFixed(1);
                process.stdout.write(
                    `\rUploading: ${formatSize(uploadedBytes)} / ${formatSize(fileSize)} (${percent}%)`
                );
            });
        }

        // Wait for completion
        const nodeUid = await uploadController.completion();
        console.log('\n');
        console.log(`Upload complete!`);
        console.log(`Node UID: ${nodeUid}`);

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
