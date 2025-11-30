/**
 * Proton Drive Sync CLI
 */

import { realpathSync } from 'fs';
import { basename } from 'path';
import { program } from 'commander';
import watchman from 'fb-watchman';
import { input, password } from '@inquirer/prompts';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';
import { getStoredCredentials, storeCredentials, deleteStoredCredentials } from './keychain.js';
import { appState, saveState } from './state.js';
import { config } from './config.js';
import { logger, enableVerbose } from './logger.js';
import pRetry from 'p-retry';
import type { ProtonDriveClient, ApiError } from './types.js';
import { createNode } from './create.js';
import { deleteNode } from './delete.js';

// ============================================================================
// Types
// ============================================================================

interface FileChange {
    name: string;
    size: number;
    mtime_ms: number;
    exists: boolean;
    type: 'f' | 'd';
    watchRoot: string; // Which watch root this change came from
}

// ============================================================================
// Constants
// ============================================================================

const SUB_NAME = 'proton-drive-sync';

// Debounce time in ms - wait for rapid changes to settle
const DEBOUNCE_MS = 500;

// ============================================================================
// Options
// ============================================================================

let dryRun = false;

// ============================================================================
// Watchman Client
// ============================================================================

const watchmanClient = new watchman.Client();

// ============================================================================
// Change Queue & Processing
// ============================================================================

// Queue of pending changes (path -> latest change info)
const pendingChanges = new Map<string, FileChange>();
let debounceTimer: NodeJS.Timeout | null = null;
let protonClient: ProtonDriveClient | null = null;
let isProcessing = false;

async function processChanges(): Promise<void> {
    if (isProcessing || !protonClient) return;
    isProcessing = true;

    // Take snapshot of current pending changes
    const changes = new Map(pendingChanges);
    pendingChanges.clear();

    for (const [path, change] of changes) {
        // Use the directory name as the prefix for the remote path
        const dirName = basename(change.watchRoot);
        const fullPath = `${dirName}/${path}`;

        try {
            if (change.exists) {
                // File or directory was created/modified
                const typeLabel = change.type === 'd' ? 'directory' : 'file';

                if (dryRun) {
                    logger.info(`[DRY-RUN] Would create/update ${typeLabel}: ${path}`);
                    continue;
                }

                logger.info(`Creating/updating ${typeLabel}: ${path}`);

                const result = await pRetry(
                    async () => {
                        const res = await createNode(protonClient!, fullPath);
                        if (!res.success) {
                            throw new Error(res.error);
                        }
                        return res;
                    },
                    {
                        retries: 3,
                        onFailedAttempt: (ctx) => {
                            logger.warn(
                                `Create attempt ${ctx.attemptNumber} failed for ${path}: ${ctx.error.message}. ${ctx.retriesLeft} retries left.`
                            );
                        },
                    }
                );
                logger.info(`Success: ${path} -> ${result.nodeUid}`);
            } else {
                // File or directory was deleted
                if (dryRun) {
                    logger.info(`[DRY-RUN] Would delete: ${path}`);
                    continue;
                }

                logger.info(`Deleting: ${path}`);

                const result = await pRetry(
                    async () => {
                        const res = await deleteNode(protonClient!, fullPath, false);
                        if (!res.success) {
                            throw new Error(res.error);
                        }
                        return res;
                    },
                    {
                        retries: 3,
                        onFailedAttempt: (ctx) => {
                            logger.warn(
                                `Delete attempt ${ctx.attemptNumber} failed for ${path}: ${ctx.error.message}. ${ctx.retriesLeft} retries left.`
                            );
                        },
                    }
                );
                if (result.existed) {
                    logger.info(`Deleted: ${path}`);
                } else {
                    logger.info(`Already gone: ${path}`);
                }
            }
        } catch (error) {
            // All retries exhausted - log error and continue (clock will still advance)
            logger.error(`Failed after 3 retries for ${path}: ${(error as Error).message}`);
        }
    }

    isProcessing = false;

    // If more changes came in while processing, schedule another run
    if (pendingChanges.size > 0) {
        scheduleProcessing();
    }
}

function scheduleProcessing(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        processChanges();
    }, DEBOUNCE_MS);
}

function queueChange(file: FileChange): void {
    const status = file.exists ? (file.type === 'd' ? 'dir changed' : 'changed') : 'deleted';
    const typeLabel = file.type === 'd' ? 'dir' : 'file';
    logger.debug(`[${status}] ${file.name} (size: ${file.size ?? 0}, type: ${typeLabel})`);

    pendingChanges.set(file.name, file);
    scheduleProcessing();
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Create a ProtonDriveClient from username/password
 */
async function createClient(username: string, pwd: string): Promise<ProtonDriveClient> {
    await initCrypto();

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

    // Load the SDK
    type SDKModule = typeof import('@protontech/drive-sdk');
    const sdk: SDKModule = await import('@protontech/drive-sdk');

    // Import telemetry module for silent logging (not exported from main index)
    const telemetryModule = await import('@protontech/drive-sdk/dist/telemetry.js');

    const httpClient = createProtonHttpClient(session!);
    const openPGPCryptoModule = createOpenPGPCrypto();
    const account = createProtonAccount(session!, openPGPCryptoModule);
    const srpModuleInstance = createSrpModule();

    // Create a silent telemetry instance (only log errors)
    const silentTelemetry = new telemetryModule.Telemetry({
        logFilter: new telemetryModule.LogFilter({ globalLevel: telemetryModule.LogLevel.ERROR }),
        logHandlers: [new telemetryModule.ConsoleLogHandler()],
        metricHandlers: [], // No metrics logging
    });

    const client = new sdk.ProtonDriveClient({
        httpClient,
        entitiesCache: new sdk.MemoryCache(),
        cryptoCache: new sdk.MemoryCache(),
        // @ts-expect-error - PrivateKey types differ between openpgp imports
        account,
        // @ts-expect-error - PrivateKey types differ between openpgp imports
        openPGPCryptoModule,
        srpModule: srpModuleInstance,
        telemetry: silentTelemetry,
    });

    return client as unknown as ProtonDriveClient;
}

/**
 * Authenticate using stored credentials (for sync command)
 */
async function authenticateFromKeychain(): Promise<ProtonDriveClient> {
    const storedCreds = await getStoredCredentials();

    if (!storedCreds) {
        logger.error('No credentials found. Run `proton-drive-sync auth` first.');
        process.exit(1);
    }

    logger.info(`Authenticating as ${storedCreds.username}...`);
    const client = await createClient(storedCreds.username, storedCreds.password);
    logger.info('Authenticated.');

    return client;
}

// ============================================================================
// Watchman Setup
// ============================================================================

function setupWatchman(): void {
    // Set up watches for all configured directories
    for (const dir of config.sync_dirs) {
        const watchDir = realpathSync(dir);
        const subName = `${SUB_NAME}-${basename(watchDir)}`;

        // Step 1: Find root (watch-project)
        watchmanClient.command(['watch-project', watchDir], (err, resp) => {
            if (err) {
                logger.error(`Watchman error for ${dir}: ${err}`);
                process.exit(1);
            }

            const watchResp = resp as watchman.WatchProjectResponse;
            const root = watchResp.watch;
            const relative = watchResp.relative_path || '';

            // Step 2: Use saved clock for this directory or null for initial sync
            const savedClock = appState.clocks[watchDir];

            if (savedClock) {
                logger.info(`Resuming ${dir} from last sync state...`);
            } else {
                logger.info(`First run - syncing all existing files in ${dir}...`);
            }

            // Step 3: Build a subscription query
            const sub: Record<string, unknown> = {
                expression: ['anyof', ['type', 'f'], ['type', 'd']], // files and directories
                fields: ['name', 'size', 'mtime_ms', 'exists', 'type'],
            };

            // Only set 'since' if we have a saved clock (otherwise get all files)
            if (savedClock) {
                sub.since = savedClock;
            }

            if (relative) {
                sub.relative_root = relative;
            }

            // Step 4: Register subscription
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (watchmanClient as any).command(
                ['subscribe', root, subName, sub],
                (err: Error | null) => {
                    if (err) {
                        logger.error(`Subscribe error for ${dir}: ${err}`);
                        process.exit(1);
                    }
                    logger.info(`Watching ${dir} for changes...`);
                }
            );
        });
    }

    // Step 5: Listen for notifications from all subscriptions
    watchmanClient.on('subscription', (resp: watchman.SubscriptionResponse) => {
        // Check if this is one of our subscriptions
        if (!resp.subscription.startsWith(SUB_NAME)) return;

        // Extract the watch root from the subscription name
        const dirName = resp.subscription.replace(`${SUB_NAME}-`, '');
        const watchRoot = config.sync_dirs.find((d) => basename(realpathSync(d)) === dirName) || '';

        // Save the clock from this notification for resume capability (skip in dry-run mode)
        const clock = (resp as unknown as { clock?: string }).clock;
        const resolvedRoot = realpathSync(watchRoot);
        if (clock && !dryRun) {
            appState.clocks[resolvedRoot] = clock;
            saveState(appState);
        }

        for (const file of resp.files) {
            const fileChange = file as unknown as Omit<FileChange, 'watchRoot'>;
            queueChange({ ...fileChange, watchRoot: realpathSync(watchRoot) });
        }
    });

    // Step 6: Handle errors & shutdown
    watchmanClient.on('error', (e: Error) => logger.error(`Watchman error: ${e}`));
    watchmanClient.on('end', () => {});

    logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

// ============================================================================
// Commands
// ============================================================================

async function authCommand(): Promise<void> {
    await initCrypto();

    const username = await input({ message: 'Proton username:' });
    const pwd = await password({ message: 'Password:' });

    if (!username || !pwd) {
        console.error('Username and password are required.');
        process.exit(1);
    }

    console.log('\nAuthenticating with Proton...');

    // Verify credentials work
    try {
        await createClient(username, pwd);
    } catch (error) {
        console.error('Authentication failed:', (error as Error).message);
        process.exit(1);
    }

    // Save to keychain
    await deleteStoredCredentials();
    await storeCredentials(username, pwd);
    console.log('Credentials saved to Keychain.');
}

async function syncCommand(options: { verbose: boolean; dryRun: boolean }): Promise<void> {
    if (options.verbose) {
        enableVerbose();
    }

    if (options.dryRun) {
        dryRun = true;
        logger.info('[DRY-RUN] Dry run mode enabled - no changes will be made');
    }

    // Authenticate using stored credentials
    protonClient = await authenticateFromKeychain();

    // Then setup watchman
    setupWatchman();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        logger.info('Shutting down...');
        watchmanClient.end();
        process.exit(0);
    });
}

// ============================================================================
// CLI Setup
// ============================================================================

program.name('proton-drive-sync').description('Sync local files to Proton Drive').version('1.0.0');

program
    .command('auth')
    .description('Authenticate and save credentials to Keychain')
    .action(authCommand);

program
    .command('sync')
    .description('Watch and sync files to Proton Drive')
    .option('-v, --verbose', 'Enable verbose output to console')
    .option('-n, --dry-run', 'Show what would be synced without making changes')
    .action(syncCommand);

program.parse();
