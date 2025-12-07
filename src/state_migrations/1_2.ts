/**
 * Migration: Version 1 -> 2
 * Adds the signals array for inter-process communication.
 */

import { logger } from '../logger.js';

export function migrate(state: Record<string, unknown>): Record<string, unknown> {
    logger.info('Migrating state from version 1 to 2: adding signals array');
    return {
        ...state,
        version: 2,
        signals: [],
    };
}
