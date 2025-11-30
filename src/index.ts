/**
 * Proton Drive Sync CLI
 */

import { program } from 'commander';
import { authCommand } from './cli/auth.js';
import { configCommand } from './cli/config.js';
import { resetCommand } from './cli/reset.js';
import { serviceInstallCommand, serviceUninstallCommand } from './cli/service.js';
import { syncCommand } from './cli/sync.js';

program.name('proton-drive-sync').description('Sync local files to Proton Drive').version('1.0.0');

program
    .command('auth')
    .description('Authenticate and save credentials to Keychain')
    .action(authCommand);

program.command('config').description('Open config file in nano').action(configCommand);

program
    .command('reset')
    .description('Reset sync state')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(resetCommand);

program
    .command('sync')
    .description('Sync changes to Proton Drive')
    .option('-v, --verbose', 'Enable verbose output to console')
    .option('-n, --dry-run', 'Show what would be synced without making changes')
    .option('-w, --watch', 'Keep running and watch for changes')
    .action(syncCommand);

const serviceCommand = program
    .command('service')
    .description('Manage launchd service (macOS only)');

serviceCommand
    .command('install')
    .description('Install and start the launchd service')
    .action(serviceInstallCommand);

serviceCommand
    .command('uninstall')
    .description('Stop and uninstall the launchd service')
    .action(serviceUninstallCommand);

program.parse();
