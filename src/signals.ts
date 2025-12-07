/**
 * Proton Drive Sync - Signal Management
 *
 * Inter-process communication via a signal queue stored in SQLite.
 * Used for graceful shutdown and other daemon control.
 */

import { execSync } from 'child_process';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

// ============================================================================
// Constants
// ============================================================================

export const SYNC_PROCESS_PATTERN = 'proton-drive-sync.* start';

// ============================================================================
// Signal Queue Functions
// ============================================================================

/**
 * Check if a proton-drive-sync process is currently running.
 * @param excludeSelf - If true, excludes the current process from the check
 */
export function isAlreadyRunning(excludeSelf = false): boolean {
    try {
        const result = execSync(`pgrep -f "${SYNC_PROCESS_PATTERN}"`, { encoding: 'utf-8' });
        const pids = result
            .trim()
            .split('\n')
            .filter((pid) => pid && (!excludeSelf || parseInt(pid) !== process.pid));
        return pids.length > 0;
    } catch {
        return false;
    }
}

/**
 * Send a signal by adding it to the signal queue.
 */
export function sendSignal(signal: string): void {
    db.insert(schema.signals).values({ signal, createdAt: new Date() }).run();
}

/**
 * Check if a specific signal is in the queue.
 */
export function hasSignal(signal: string): boolean {
    const row = db.select().from(schema.signals).where(eq(schema.signals.signal, signal)).get();
    return !!row;
}

/**
 * Remove a signal from the queue (consume it).
 * Returns true if the signal was found and removed, false otherwise.
 */
export function consumeSignal(signal: string): boolean {
    const row = db.select().from(schema.signals).where(eq(schema.signals.signal, signal)).get();
    if (!row) return false;

    db.delete(schema.signals).where(eq(schema.signals.id, row.id)).run();
    return true;
}

// ============================================================================
// Process Control
// ============================================================================

/**
 * Kill any running proton-drive-sync sync processes.
 * Returns true if processes were found and killed, false otherwise.
 */
export function killSyncProcesses(): boolean {
    try {
        execSync(`pkill -f "${SYNC_PROCESS_PATTERN}"`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
