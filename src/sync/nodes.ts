/**
 * Proton Drive Sync - Node Mapping Storage
 *
 * Tracks the mapping between local paths and Proton Drive nodeUids.
 * Used to support efficient rename/move operations without re-uploading.
 */

import { eq, like } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { nodeMapping } from '../db/schema.js';
import { getConfig } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface NodeMappingInfo {
  nodeUid: string;
  parentNodeUid: string;
  isDirectory: boolean;
}

// ============================================================================
// Node Mapping CRUD
// ============================================================================

/**
 * Get the node mapping for a local path.
 */
export function getNodeMapping(localPath: string, tx?: Tx): NodeMappingInfo | null {
  const target = tx ?? db;
  const result = target
    .select()
    .from(nodeMapping)
    .where(eq(nodeMapping.localPath, localPath))
    .get();
  if (!result) return null;
  return {
    nodeUid: result.nodeUid,
    parentNodeUid: result.parentNodeUid,
    isDirectory: result.isDirectory,
  };
}

/**
 * Store or update the node mapping for a local path.
 */
export function setNodeMapping(
  localPath: string,
  nodeUid: string,
  parentNodeUid: string,
  isDirectory: boolean,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  tx.insert(nodeMapping)
    .values({
      localPath,
      nodeUid,
      parentNodeUid,
      isDirectory,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: nodeMapping.localPath,
      set: {
        nodeUid,
        parentNodeUid,
        isDirectory,
        updatedAt: new Date(),
      },
    })
    .run();
}

/**
 * Delete the node mapping for a local path.
 */
export function deleteNodeMapping(localPath: string, dryRun: boolean, tx: Tx): void {
  if (dryRun) return;
  tx.delete(nodeMapping).where(eq(nodeMapping.localPath, localPath)).run();
}

/**
 * Delete all node mappings under a directory path.
 * Used when a directory is deleted.
 */
export function deleteNodeMappingsUnderPath(dirPath: string, tx: Tx): void {
  const pathPrefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  tx.delete(nodeMapping)
    .where(like(nodeMapping.localPath, `${pathPrefix}%`))
    .run();
}

/**
 * Update the path for a node mapping (used after rename/move).
 */
export function updateNodeMappingPath(
  oldLocalPath: string,
  newLocalPath: string,
  newParentNodeUid: string | undefined,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  const updateSet: { localPath: string; updatedAt: Date; parentNodeUid?: string } = {
    localPath: newLocalPath,
    updatedAt: new Date(),
  };

  if (newParentNodeUid !== undefined) {
    updateSet.parentNodeUid = newParentNodeUid;
  }

  tx.update(nodeMapping).set(updateSet).where(eq(nodeMapping.localPath, oldLocalPath)).run();
}

/**
 * Update all node mappings under a directory when the directory is renamed.
 * Replaces oldDirPath prefix with newDirPath for all children.
 */
export function updateNodeMappingsUnderPath(
  oldDirPath: string,
  newDirPath: string,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  const pathPrefix = oldDirPath.endsWith('/') ? oldDirPath : `${oldDirPath}/`;
  const children = tx
    .select()
    .from(nodeMapping)
    .where(like(nodeMapping.localPath, `${pathPrefix}%`))
    .all();

  for (const child of children) {
    const newPath = newDirPath + child.localPath.slice(oldDirPath.length);
    tx.update(nodeMapping)
      .set({ localPath: newPath, updatedAt: new Date() })
      .where(eq(nodeMapping.localPath, child.localPath))
      .run();
  }
}

/**
 * Remove node mappings for paths no longer under any sync directory.
 */
export function cleanupOrphanedNodeMappings(tx: Tx): number {
  const config = getConfig();
  const syncDirs = config.sync_dirs;

  if (syncDirs.length === 0) {
    // No sync dirs configured, clear all mappings
    tx.delete(nodeMapping).run();
    return 0;
  }

  // Get all mappings
  const allMappings = tx.select().from(nodeMapping).all();
  let removedCount = 0;

  for (const mapping of allMappings) {
    const isUnderSyncDir = syncDirs.some(
      (dir) =>
        mapping.localPath === dir.source_path || mapping.localPath.startsWith(`${dir.source_path}/`)
    );

    if (!isUnderSyncDir) {
      tx.delete(nodeMapping).where(eq(nodeMapping.localPath, mapping.localPath)).run();
      removedCount++;
    }
  }

  return removedCount;
}
