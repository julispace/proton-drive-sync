/**
 * Sync CLI Command
 *
 * Handles CLI argument parsing and delegates to the sync engine.
 */

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  acquireRunLock,
  releaseRunLock,
  startSignalListener,
  stopSignalListener,
  registerSignalHandler,
} from '../signals.js';
import { authenticateFromKeychain } from './auth.js';
import { runOneShotSync, runWatchMode } from '../sync/index.js';

// ============================================================================
// Types
// ============================================================================

interface StartOptions {
  watch?: boolean;
  dryRun?: boolean;
  debug?: boolean | string;
}

// ============================================================================
// CLI Command
// ============================================================================

/**
 * Main entry point for the sync command.
 */
export async function startCommand(options: StartOptions): Promise<void> {
  // Set debug level from CLI flag
  if (options.debug) {
    const level = typeof options.debug === 'string' ? parseInt(options.debug, 10) : 1;
    process.env.DEBUG_LEVEL = String(level);
    if (level >= 1) logger.debug(`Debug level ${level}: app debug enabled`);
    if (level >= 2) logger.debug(`Debug level ${level}: SDK debug enabled`);
  }

  // Load configuration
  const config = loadConfig();
  if (!config) {
    logger.error('No config file found. Run `proton-drive-sync init` first.');
    process.exit(1);
  }

  // Validate sync directories
  if (!config.sync_dirs || config.sync_dirs.length === 0) {
    logger.error('No sync directories configured. Add sync_dirs to your config file.');
    process.exit(1);
  }

  // Acquire run lock (prevents multiple instances)
  const lockAcquired = acquireRunLock();
  if (!lockAcquired) {
    logger.error('Another instance is already running. Use `proton-drive-sync stop` to stop it.');
    process.exit(1);
  }

  // Start signal listener for IPC
  startSignalListener();

  // Authenticate with Proton
  const sdkDebug = typeof options.debug === 'string' ? parseInt(options.debug, 10) >= 2 : false;
  let client;
  try {
    client = await authenticateFromKeychain(sdkDebug);
  } catch (error) {
    logger.error(`Authentication failed: ${error}`);
    releaseRunLock();
    stopSignalListener();
    process.exit(1);
  }

  const dryRun = options.dryRun ?? false;

  // Set up cleanup handler
  const cleanup = (): void => {
    stopSignalListener();
    releaseRunLock();
  };

  // Handle stop signal
  registerSignalHandler('stop', () => {
    logger.info('Stop signal received');
    cleanup();
    process.exit(0);
  });

  // Handle Ctrl+C
  process.once('SIGINT', () => {
    logger.info('Interrupted');
    cleanup();
    process.exit(0);
  });

  try {
    if (options.watch) {
      // Watch mode: continuous sync
      await runWatchMode({ config, client, dryRun, watch: true });
    } else {
      // One-shot mode: sync once and exit
      await runOneShotSync({ config, client, dryRun, watch: false });
    }
  } catch (error) {
    logger.error(`Sync failed: ${error}`);
    cleanup();
    process.exit(1);
  }

  cleanup();
}
