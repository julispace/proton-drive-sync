/**
 * Sync Engine
 *
 * Orchestrates the sync process: coordinates watcher, queue, and processor.
 */

import { join, basename } from 'path';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import { registerSignalHandler } from '../signals.js';
import { isPaused } from '../flags.js';
import { sendStatusToDashboard } from '../dashboard/server.js';
import { getConfig, onConfigChange } from '../config.js';
import { cleanupOrphanedClocks } from '../state.js';
import type { Config } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  connectWatchman,
  closeWatchman,
  queryAllChanges,
  setupWatchSubscriptions,
  type FileChange,
} from './watcher.js';
import { enqueueJob, cleanupOrphanedJobs } from './queue.js';
import {
  processAvailableJobs,
  waitForActiveTasks,
  getActiveTaskCount,
  drainQueue,
  setSyncConcurrency,
} from './processor.js';
import { JOB_POLL_INTERVAL_MS, SHUTDOWN_TIMEOUT_MS } from './constants.js';

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

  // Find the sync dir config for this watch root
  const syncDir = config.sync_dirs.find((d) => file.watchRoot.startsWith(d.source_path));
  const remoteRoot = syncDir?.remote_root || '';

  // Build remote path: remote_root/dirName/file.name
  const dirName = basename(file.watchRoot);
  const remotePath = remoteRoot
    ? `${remoteRoot}/${dirName}/${file.name}`
    : `${dirName}/${file.name}`;

  // Determine event type
  let eventType: SyncEventType;
  if (!file.exists) {
    eventType = SyncEventType.DELETE;
  } else if (file.new) {
    eventType = SyncEventType.CREATE;
  } else {
    eventType = SyncEventType.UPDATE;
  }

  // Log the change with details
  const status = file.exists ? (file.type === 'd' ? 'dir changed' : 'changed') : 'deleted';
  const typeLabel = file.type === 'd' ? 'dir' : 'file';
  logger.debug(`[${status}] ${file.name} (size: ${file.size ?? 0}, type: ${typeLabel})`);
  logger.debug(`Enqueueing ${eventType} job for ${typeLabel}: ${file.name}`);

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

  await connectWatchman();

  // Clean up stale/orphaned jobs from previous run
  cleanupOrphanedJobs(dryRun);

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

  // Process all jobs until queue is empty
  await drainQueue(client, dryRun);
  logger.info('Sync complete');

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

  await connectWatchman();

  // Initialize concurrency from config
  setSyncConcurrency(config.sync_concurrency);

  // Helper to create file change handler with current config
  const createFileHandler = () => (file: FileChange) => handleFileChange(file, getConfig(), dryRun);

  // Clean up stale/orphaned jobs and clocks from previous run
  cleanupOrphanedJobs(dryRun);
  cleanupOrphanedClocks(dryRun);

  // Set up file watching
  await setupWatchSubscriptions(config, createFileHandler(), dryRun);

  // Wire up config change handlers
  onConfigChange('sync_concurrency', () => {
    setSyncConcurrency(getConfig().sync_concurrency);
  });

  onConfigChange('sync_dirs', async () => {
    logger.info('sync_dirs changed, reinitializing watch subscriptions...');
    const newConfig = getConfig();
    cleanupOrphanedJobs(dryRun);
    cleanupOrphanedClocks(dryRun);
    await setupWatchSubscriptions(newConfig, createFileHandler(), dryRun);
  });

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
  await processorHandle.stop();
}

// ============================================================================
// Job Processor Loop
// ============================================================================

interface ProcessorHandle {
  stop: () => Promise<void>;
}

/**
 * Start the job processor loop that polls for pending jobs.
 */
function startJobProcessorLoop(client: ProtonDriveClient, dryRun: boolean): ProcessorHandle {
  let running = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const processLoop = (): void => {
    if (!running) return;

    const paused = isPaused();

    // Always send heartbeat (merged with job processing)
    sendStatusToDashboard({ paused });

    if (!paused) {
      processAvailableJobs(client, dryRun);
    }

    if (running) {
      timeoutId = setTimeout(processLoop, JOB_POLL_INTERVAL_MS);
    }
  };

  // Start the loop
  processLoop();

  return {
    stop: async () => {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Wait for active tasks to complete (with timeout)
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS)
      );
      const result = await Promise.race([
        waitForActiveTasks().then(() => 'done' as const),
        timeoutPromise,
      ]);
      if (result === 'timeout') {
        logger.warn(`Shutdown timeout: ${getActiveTaskCount()} tasks abandoned`);
      }
    },
  };
}
