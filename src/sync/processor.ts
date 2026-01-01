/**
 * Sync Job Processor
 *
 * Executes sync jobs: create/update/delete/rename/move operations against Proton Drive.
 */

import { SyncEventType } from '../db/schema.js';
import { db } from '../db/index.js';
import { createNode } from '../proton/create.js';
import { deleteNode } from '../proton/delete.js';
import { relocateNode, getParentFolderUid } from '../proton/rename.js';
import { logger } from '../logger.js';
import { DEFAULT_SYNC_CONCURRENCY } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  type Job,
  enqueueJob,
  getNextPendingJob,
  markJobSynced,
  markJobBlocked,
  setJobError,
  categorizeError,
  scheduleRetry,
  ErrorCategory,
} from './queue.js';
import {
  getNodeMapping,
  setNodeMapping,
  deleteNodeMapping,
  updateNodeMappingPath,
} from './nodes.js';
import { setFileHash, deleteStoredHash, updateStoredHashPath } from './hashes.js';
import * as path from 'node:path';
import { REUPLOAD_DELETE_RECREATE_THRESHOLD } from './constants.js';

// ============================================================================
// Task Pool State (persistent across iterations)
// ============================================================================

/** Active tasks: jobId -> promise */
const activeTasks = new Map<number, Promise<void>>();

// ============================================================================
// Dynamic Concurrency
// ============================================================================

/** Current sync concurrency - can be updated via config change */
let syncConcurrency = DEFAULT_SYNC_CONCURRENCY;

/** Update the sync concurrency value */
export function setSyncConcurrency(value: number): void {
  syncConcurrency = value;
  logger.info(`Sync concurrency updated to ${value}`);
}

// ============================================================================
// Task Pool Management
// ============================================================================

/**
 * Wait for all active tasks to complete.
 */
export function waitForActiveTasks(): Promise<void> {
  return Promise.all(activeTasks.values()).then(() => {});
}

/**
 * Get the number of currently active tasks.
 */
export function getActiveTaskCount(): number {
  return activeTasks.size;
}

/**
 * Process all pending jobs until queue is empty (blocking).
 * Used for one-shot sync mode.
 */
export async function drainQueue(client: ProtonDriveClient, dryRun: boolean): Promise<void> {
  // Keep processing until no more jobs and no active tasks
  while (true) {
    processAvailableJobs(client, dryRun);

    if (activeTasks.size === 0) {
      // Check if there are more jobs (could have been added during processing)
      const job = getNextPendingJob(dryRun);
      if (!job) break; // Queue is truly empty

      // Process it directly
      const jobId = job.id;
      const taskPromise = processJob(client, job, dryRun).finally(() => {
        activeTasks.delete(jobId);
      });
      activeTasks.set(jobId, taskPromise);
    }

    // Wait for at least one task to complete
    if (activeTasks.size > 0) {
      await Promise.race(activeTasks.values());
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Extract error message from unknown error */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Helper to delete a node, throws on failure */
async function deleteNodeOrThrow(
  client: ProtonDriveClient,
  remotePath: string,
  dryRun: boolean
): Promise<{ existed: boolean }> {
  const result = await deleteNode(client, remotePath, dryRun);
  if (!result.success) {
    throw new Error(result.error);
  }
  return { existed: result.existed };
}

/** Helper to create/update a node, throws on failure */
async function createNodeOrThrow(
  client: ProtonDriveClient,
  localPath: string,
  remotePath: string,
  dryRun: boolean
): Promise<{ nodeUid: string; parentNodeUid: string; isDirectory: boolean }> {
  const result = await createNode(client, localPath, remotePath, dryRun);
  if (!result.success || !result.nodeUid) {
    throw new Error(result.error ?? 'createNode returned success but no nodeUid');
  }
  return {
    nodeUid: result.nodeUid,
    parentNodeUid: result.parentNodeUid ?? 'unknown',
    isDirectory: result.isDirectory ?? false,
  };
}

/**
 * Process available jobs up to concurrency limit (non-blocking).
 * Spawns new tasks to fill available capacity and returns immediately.
 * Call this periodically to keep the task pool saturated.
 */
export function processAvailableJobs(client: ProtonDriveClient, dryRun: boolean): void {
  // Calculate available capacity
  const availableSlots = syncConcurrency - activeTasks.size;
  if (availableSlots <= 0) return;

  // Spawn tasks to fill available slots
  for (let i = 0; i < availableSlots; i++) {
    const job = getNextPendingJob(dryRun);
    if (!job) break; // No more pending jobs

    const jobId = job.id;

    // Start the job and track it
    const taskPromise = processJob(client, job, dryRun).finally(() => {
      activeTasks.delete(jobId);
    });

    activeTasks.set(jobId, taskPromise);
  }
}

/**
 * Process a single job (internal helper).
 */
async function processJob(client: ProtonDriveClient, job: Job, dryRun: boolean): Promise<void> {
  const { id, eventType, localPath, remotePath, nRetries, oldLocalPath, oldRemotePath } = job;

  if (!remotePath) {
    throw new Error(`Job ${id} missing required remotePath`);
  }

  try {
    switch (eventType) {
      case SyncEventType.DELETE: {
        logger.info(`Deleting: ${remotePath}`);
        const { existed } = await deleteNodeOrThrow(client, remotePath, dryRun);
        logger.info(existed ? `Deleted: ${remotePath}` : `Already gone: ${remotePath}`);
        // Remove node mapping on delete
        db.transaction((tx) => {
          deleteNodeMapping(localPath, dryRun, tx);
          markJobSynced(id, localPath, dryRun, tx);
        });
        return;
      }

      case SyncEventType.CREATE:
      case SyncEventType.UPDATE: {
        const typeLabel = eventType === SyncEventType.CREATE ? 'Creating' : 'Updating';
        logger.info(`${typeLabel}: ${remotePath}`);
        const { nodeUid, parentNodeUid, isDirectory } = await createNodeOrThrow(
          client,
          localPath,
          remotePath,
          dryRun
        );
        logger.info(`Success: ${remotePath} -> ${nodeUid}`);
        // Store node mapping and content hash for future operations
        db.transaction((tx) => {
          setNodeMapping(localPath, nodeUid, parentNodeUid, isDirectory, dryRun, tx);
          if (job.contentHash) {
            setFileHash(localPath, job.contentHash, dryRun, tx);
          }
          markJobSynced(id, localPath, dryRun, tx);
        });
        return;
      }

      case SyncEventType.DELETE_AND_CREATE: {
        if (!oldLocalPath || !oldRemotePath) {
          throw new Error(
            `DELETE_AND_CREATE event missing required paths: oldLocalPath=${oldLocalPath}, oldRemotePath=${oldRemotePath}`
          );
        }
        // Step 1: Delete old remote path (ignore if not exists)
        logger.info(`Delete+Create: deleting ${oldRemotePath}`);
        await deleteNodeOrThrow(client, oldRemotePath, dryRun);

        // Step 2: Clean up old mappings
        db.transaction((tx) => {
          deleteNodeMapping(oldLocalPath, dryRun, tx);
          deleteStoredHash(oldLocalPath, dryRun, tx);
        });

        // Step 3: Create at new path
        logger.info(`Delete+Create: creating ${remotePath}`);
        const { nodeUid, parentNodeUid, isDirectory } = await createNodeOrThrow(
          client,
          localPath,
          remotePath,
          dryRun
        );

        // Step 4: Store new mappings
        db.transaction((tx) => {
          setNodeMapping(localPath, nodeUid, parentNodeUid, isDirectory, dryRun, tx);
          if (job.contentHash) {
            setFileHash(localPath, job.contentHash, dryRun, tx);
          }
          markJobSynced(id, localPath, dryRun, tx);
        });

        logger.info(`Delete+Create complete: ${oldRemotePath} -> ${remotePath}`);
        return;
      }

      case SyncEventType.RENAME: {
        if (!oldLocalPath || !oldRemotePath) {
          throw new Error(
            `RENAME event missing required paths: oldLocalPath=${oldLocalPath}, oldRemotePath=${oldRemotePath}`
          );
        }
        logger.info(`Renaming: ${oldRemotePath} -> ${remotePath}`);
        const mapping = getNodeMapping(oldLocalPath);
        if (!mapping) {
          throw new Error(`Node mapping not found for ${oldLocalPath}, cannot rename`);
        }
        const newName = path.basename(localPath);
        const result = await relocateNode(client, mapping.nodeUid, { newName }, dryRun);
        if (!result.success) {
          throw new Error(result.error);
        }
        db.transaction((tx) => {
          updateNodeMappingPath(oldLocalPath, localPath, undefined, dryRun, tx);
          updateStoredHashPath(oldLocalPath, localPath, dryRun, tx);
          markJobSynced(id, localPath, dryRun, tx);
        });
        logger.info(`Renamed: ${oldRemotePath} -> ${remotePath}`);
        return;
      }

      case SyncEventType.MOVE: {
        if (!oldLocalPath || !oldRemotePath) {
          throw new Error(
            `MOVE event missing required paths: oldLocalPath=${oldLocalPath}, oldRemotePath=${oldRemotePath}`
          );
        }
        logger.info(`Moving: ${oldRemotePath} -> ${remotePath}`);
        const moveMapping = getNodeMapping(oldLocalPath);
        if (!moveMapping) {
          throw new Error(`Node mapping not found for ${oldLocalPath}, cannot move`);
        }

        // Get the new parent's nodeUid by passing the full remotePath
        // getParentFolderUid resolves the parent directory of the given path
        const newParentNodeUid = await getParentFolderUid(client, remotePath, dryRun);
        if (!newParentNodeUid) {
          throw new Error(`Parent folder not found for ${remotePath}`);
        }

        const oldName = path.basename(oldLocalPath);
        const newName = path.basename(localPath);
        const nameChanged = oldName !== newName;

        const moveResult = await relocateNode(
          client,
          moveMapping.nodeUid,
          {
            newParentNodeUid,
            newName: nameChanged ? newName : undefined,
          },
          dryRun
        );
        if (!moveResult.success) {
          throw new Error(moveResult.error);
        }
        db.transaction((tx) => {
          updateNodeMappingPath(oldLocalPath, localPath, newParentNodeUid, dryRun, tx);
          updateStoredHashPath(oldLocalPath, localPath, dryRun, tx);
          markJobSynced(id, localPath, dryRun, tx);
        });
        logger.info(`Moved: ${oldRemotePath} -> ${remotePath}`);
        return;
      }

      default: {
        const _exhaustive: never = eventType;
        throw new Error(`Unknown event type: ${_exhaustive}`);
      }
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const { category: errorCategory, maxRetries } = categorizeError(errorMessage);

    if (nRetries >= maxRetries && maxRetries !== Infinity) {
      // Block the job after exhausting retries
      logger.error(
        `Job ${id} (${localPath}) failed permanently after ${maxRetries} retries: ${errorMessage}`
      );
      db.transaction((tx) => {
        setJobError(id, errorMessage, dryRun, tx);
        markJobBlocked(id, localPath, errorMessage, dryRun, tx);
      });
    } else if (
      errorCategory === ErrorCategory.REUPLOAD_NEEDED &&
      nRetries >= REUPLOAD_DELETE_RECREATE_THRESHOLD
    ) {
      // REUPLOAD_NEEDED with retry count >= 2: enqueue DELETE_AND_CREATE job
      logger.warn(`Job ${id} (${localPath}) retry ${nRetries}, converting to DELETE_AND_CREATE`);
      db.transaction((tx) => {
        enqueueJob(
          {
            eventType: SyncEventType.DELETE_AND_CREATE,
            localPath,
            remotePath,
            oldLocalPath: localPath,
            oldRemotePath: remotePath,
            contentHash: job.contentHash,
          },
          dryRun,
          tx
        );
      });
    } else {
      // Schedule retry for all other cases
      logger.error(`Job ${id} (${localPath}) failed: ${errorMessage}`);
      db.transaction((tx) => {
        setJobError(id, errorMessage, dryRun, tx);
        scheduleRetry(id, localPath, nRetries, errorCategory, dryRun, tx);
      });
    }
  }
}
