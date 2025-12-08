import { Command } from 'commander';
import { startDashboard } from '../dashboard/server.js';
import { logger } from '../logger.js';

export function dashboardCommand(this: Command): void {
  logger.info('Starting dashboard...');

  startDashboard();

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Stopping dashboard...');
    process.exit(0);
  });
}
