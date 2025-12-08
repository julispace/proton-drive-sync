/**
 * Sync Engine
 *
 * Orchestrates the sync process: coordinates watcher, queue, and processor.
 */

import { join } from 'path';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import { registerSignalHandler } from '../signals.js';
import { startDashboard, stopDashboard } from '../dashboard/server.js';
import type { Config } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  waitForWatchman,
  closeWatchman,
  queryAllChanges,
  setupWatchSubscriptions,
  type FileChange,
} from './watcher.js';
import { enqueueJob } from './queue.js';
import { processAllPendingJobs } from './processor.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncOptions {
  config: Config;
  client: ProtonDriveClient;
  dryRun: boolean;
  watch: boolean;
}

// ============================================================================
// File Change Handler
// ============================================================================

/**
 * Convert a file change event to a sync job and enqueue it.
 */
function handleFileChange(file: FileChange, config: Config, dryRun: boolean): void {
  const localPath = join(file.watchRoot, file.name);
  const remotePath = join(config.remote_root, file.name);

  // Determine event type
  let eventType: SyncEventType;
  if (!file.exists) {
    eventType = SyncEventType.DELETE;
  } else if (file.new) {
    eventType = SyncEventType.CREATE;
  } else {
    eventType = SyncEventType.UPDATE;
  }

  // Log the change
  const action =
    eventType === SyncEventType.DELETE
      ? 'Delete'
      : eventType === SyncEventType.CREATE
        ? 'Create'
        : 'Update';
  logger.debug(`${action}: ${file.name} (type: ${file.type})`);

  // Enqueue the job
  enqueueJob({ eventType, localPath, remotePath }, dryRun);
}

// ============================================================================
// One-Shot Sync
// ============================================================================

/**
 * Run a one-shot sync: query all changes and process them.
 */
export async function runOneShotSync(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await waitForWatchman();

  // Query all changes and enqueue jobs
  const totalChanges = await queryAllChanges(
    config,
    (file) => handleFileChange(file, config, dryRun),
    dryRun
  );

  if (totalChanges === 0) {
    logger.info('No changes to sync');
    return;
  }

  logger.info(`Found ${totalChanges} changes to sync`);

  // Process all jobs
  const processed = await processAllPendingJobs(client, dryRun);
  logger.info(`Processed ${processed} jobs`);

  closeWatchman();
}

// ============================================================================
// Watch Mode
// ============================================================================

/**
 * Run in watch mode: continuously watch for changes and process them.
 */
export async function runWatchMode(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await waitForWatchman();

  // Start the dashboard
  startDashboard(dryRun);

  // Set up file watching
  await setupWatchSubscriptions(config, (file) => handleFileChange(file, config, dryRun), dryRun);

  // Start the job processor loop
  const processorHandle = startJobProcessorLoop(client, dryRun);

  // Wait for stop signal
  await new Promise<void>((resolve) => {
    const handleStop = (): void => {
      logger.info('Stop signal received, shutting down...');
      resolve();
    };

    const handleSigint = (): void => {
      logger.info('Ctrl+C received, shutting down...');
      resolve();
    };

    registerSignalHandler('stop', handleStop);
    process.once('SIGINT', handleSigint);
  });

  // Cleanup
  processorHandle.stop();
  stopDashboard();
  closeWatchman();
}

// ============================================================================
// Job Processor Loop
// ============================================================================

interface ProcessorHandle {
  stop: () => void;
}

/**
 * Start the job processor loop that polls for pending jobs.
 */
function startJobProcessorLoop(client: ProtonDriveClient, dryRun: boolean): ProcessorHandle {
  let running = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const processLoop = async (): Promise<void> => {
    if (!running) return;

    logger.debug('Job processor polling...');

    try {
      await processAllPendingJobs(client, dryRun);
    } catch (error) {
      logger.error(`Job processor error: ${error}`);
    }

    if (running) {
      timeoutId = setTimeout(processLoop, 1000);
    }
  };

  // Start the loop
  processLoop();

  return {
    stop: () => {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}
