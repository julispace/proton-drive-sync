/**
 * Proton Drive Sync - Logger
 *
 * Logs to both file and console by default.
 * In daemon mode, console logging is disabled.
 * In dry-run mode, file logging is disabled and [DRY-RUN] prefix is added.
 */

import winston from 'winston';
import { STATE_DIR } from './db/index.js';

const LOG_FILE = `${STATE_DIR}/sync.log`;

let dryRunMode = false;

const fileTransport = new winston.transports.File({ filename: LOG_FILE });

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ level, message }) => {
    const prefix = dryRunMode ? '[DRY-RUN] ' : '';
    return `${level}: ${prefix}${message}`;
  })
);

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [fileTransport, new winston.transports.Console({ format: consoleFormat })],
});

/**
 * Disable console logging (for daemon mode - background process)
 */
export function disableConsoleLogging(): void {
  logger.transports.forEach((transport) => {
    if (transport instanceof winston.transports.Console) {
      transport.silent = true;
    }
  });
}

/**
 * Enable dry-run mode: disables file logging, adds [DRY-RUN] prefix to console
 */
export function setDryRun(enabled: boolean): void {
  dryRunMode = enabled;
  if (enabled) {
    logger.remove(fileTransport);
  }
}

/**
 * Enable debug level logging
 */
export function enableDebug(): void {
  logger.level = 'debug';
}

/**
 * Check if debug logging is enabled
 */
export function isDebugEnabled(): boolean {
  return logger.level === 'debug';
}
