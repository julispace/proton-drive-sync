/**
 * Proton Drive Sync - State Management
 *
 * Persists sync state to ~/.local/state/proton-drive-sync/state.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { xdgState } from 'xdg-basedir';
import { logger } from './logger.js';
import { migrate as migrate1to2 } from './state_migrations/1_2.js';

// ============================================================================
// Types
// ============================================================================

export interface StateData {
    /** State schema version */
    version: number;
    /** Per-directory clocks keyed by directory path */
    clocks: Record<string, string>;
    /** Signal queue for inter-process communication (e.g., 'stop') */
    signals: string[];
}

// ============================================================================
// Constants
// ============================================================================

const STATE_VERSION = 2;

// Migration functions indexed by source version
const MIGRATIONS: Record<number, (state: Record<string, unknown>) => Record<string, unknown>> = {
    1: migrate1to2,
};

if (!xdgState) {
    console.error('Could not determine XDG state directory');
    process.exit(1);
}

export const STATE_DIR = join(xdgState, 'proton-drive-sync');
const STATE_FILE = join(STATE_DIR, 'state.json');

// ============================================================================
// State Management
// ============================================================================

function runMigrations(state: Record<string, unknown>): StateData {
    let currentVersion = (state.version as number) || 1;

    while (currentVersion < STATE_VERSION) {
        const migration = MIGRATIONS[currentVersion];
        if (!migration) {
            logger.error(`No migration found for version ${currentVersion}`);
            break;
        }
        state = migration(state);
        currentVersion = state.version as number;
    }

    return state as unknown as StateData;
}

function loadState(): StateData {
    if (!existsSync(STATE_FILE)) {
        return { version: STATE_VERSION, clocks: {}, signals: [] };
    }
    try {
        const rawState = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));

        // Run migrations if needed
        if (rawState.version < STATE_VERSION) {
            const migratedState = runMigrations(rawState);
            saveState(migratedState);
            return migratedState;
        }

        return rawState;
    } catch {
        return { version: STATE_VERSION, clocks: {}, signals: [] };
    }
}

export function saveState(data: StateData): void {
    if (!existsSync(STATE_DIR)) {
        mkdirSync(STATE_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

export const appState = loadState();
