/**
 * Dashboard Server - Spawns dashboard as a separate process
 *
 * The dashboard runs in its own Node.js process for true parallelism,
 * communicating via IPC for job events.
 */

import { fork, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { jobEvents, type JobEvent } from '../sync/queue.js';
import { logger } from '../logger.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Server Management
// ============================================================================

let dashboardProcess: ChildProcess | null = null;
let jobEventHandler: ((event: JobEvent) => void) | null = null;

/**
 * Start the dashboard in a separate process.
 */
export function startDashboard(dryRun = false): void {
  if (dashboardProcess) {
    logger.warn('Dashboard process already running');
    return;
  }

  logger.debug(`Dashboard starting with dryRun=${dryRun}`);

  // Fork the dashboard subprocess
  const mainPath = join(__dirname, 'main.js');
  dashboardProcess = fork(mainPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  // Handle messages from child
  dashboardProcess.on('message', (msg: { type: string; port?: number }) => {
    if (msg.type === 'ready') {
      logger.info(`Dashboard running at http://localhost:${msg.port}`);
    }
  });

  // Handle child process errors
  dashboardProcess.on('error', (err) => {
    logger.error(`Dashboard process error: ${err.message}`);
  });

  // Handle child process exit
  dashboardProcess.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      logger.warn(`Dashboard process exited with code ${code}, signal ${signal}`);
    }
    dashboardProcess = null;
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }
  });

  // Send initial config
  dashboardProcess.send({ type: 'config', dryRun });

  // Forward job events to child process via IPC
  jobEventHandler = (event: JobEvent) => {
    if (dashboardProcess?.connected) {
      dashboardProcess.send({ type: 'job', event });
    }
  };
  jobEvents.on('job', jobEventHandler);
}

/**
 * Stop the dashboard process.
 */
export function stopDashboard(): void {
  if (dashboardProcess) {
    // Remove event listener
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }

    // Gracefully terminate the child process
    dashboardProcess.kill('SIGTERM');
    dashboardProcess = null;
    logger.debug('Dashboard process stopped');
  }
}
