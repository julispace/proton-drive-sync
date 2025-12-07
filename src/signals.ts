/**
 * Proton Drive Sync - Signal Management
 *
 * Inter-process communication via a signal queue stored in state.
 * Used for graceful shutdown and other daemon control.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { xdgState } from 'xdg-basedir';
import { appState, saveState } from './state.js';

// ============================================================================
// Constants
// ============================================================================

const STATE_FILE = join(xdgState!, 'proton-drive-sync', 'state.json');

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
 * Send a signal to the sync daemon by adding it to the signal queue.
 */
export function sendSignal(signal: string): void {
    appState.signals.push(signal);
    saveState(appState);
}

/**
 * Check if a specific signal is in the queue.
 * Re-reads state from disk to get the latest signals.
 */
export function hasSignal(signal: string): boolean {
    if (!existsSync(STATE_FILE)) return false;
    try {
        const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        return data.signals?.includes(signal) ?? false;
    } catch {
        return false;
    }
}

/**
 * Remove a signal from the queue (consume it).
 * Re-reads state from disk to get the latest signals.
 * Returns true if the signal was found and removed, false otherwise.
 */
export function consumeSignal(signal: string): boolean {
    if (!existsSync(STATE_FILE)) return false;
    try {
        const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        const index = data.signals?.indexOf(signal) ?? -1;
        if (index === -1) return false;

        data.signals.splice(index, 1);
        writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch {
        return false;
    }
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
