/**
 * Proton Drive Sync - Logger
 *
 * Logs to file by default, and to console if verbose mode is enabled.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import winston from 'winston';
import { xdgState } from 'xdg-basedir';

// Define state directory here to avoid circular dependency with state.ts
const STATE_DIR = join(xdgState!, 'proton-drive-sync');

// Ensure state directory exists for log file
if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
}

const LOG_FILE = join(STATE_DIR, 'sync.log');

// Create base transports (always log to file)
const transports: winston.transport[] = [
    new winston.transports.File({
        filename: LOG_FILE,
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
];

// Create the logger
export const logger = winston.createLogger({
    level: 'info',
    transports,
});

/**
 * Enable verbose mode (also log to console)
 */
export function enableVerbose(): void {
    logger.add(
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `${timestamp} ${level}: ${message}`;
                })
            ),
        })
    );
}
