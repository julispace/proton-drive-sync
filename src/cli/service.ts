/**
 * Service install/uninstall commands for macOS launchd
 */

import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { sendSignal } from '../signals.js';
import { setFlag, clearFlag, hasFlag, FLAGS } from '../flags.js';
import { logger } from '../logger.js';
// @ts-expect-error Bun text imports
import syncPlistTemplate from './templates/proton-drive-sync.plist' with { type: 'text' };

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');

const SERVICE_NAME = 'com.damianb-bitflipper.proton-drive-sync';
const PLIST_PATH = join(PLIST_DIR, `${SERVICE_NAME}.plist`);

function getBinPathSafe(): string | null {
  const result = Bun.spawnSync(['which', 'proton-drive-sync']);
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

function generateSyncPlist(binPath: string): string {
  const home = homedir();
  return syncPlistTemplate
    .replace('{{SERVICE_NAME}}', SERVICE_NAME)
    .replace('{{BIN_PATH}}', binPath)
    .replace(/\{\{HOME\}\}/g, home);
}

interface ServiceResult {
  success: boolean;
  error?: string;
}

function loadService(name: string, plistPath: string): ServiceResult {
  const uid = new TextDecoder().decode(Bun.spawnSync(['id', '-u']).stdout).trim();
  const bootstrap = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, plistPath]);

  if (bootstrap.exitCode === 0) {
    return { success: true };
  }

  // Bootstrap failed - check if already loaded (exit code 37 = "Service already loaded")
  const bootstrapStderr = new TextDecoder().decode(bootstrap.stderr).trim();
  const alreadyLoaded = bootstrap.exitCode === 37 || bootstrapStderr.includes('already loaded');

  if (alreadyLoaded) {
    // Already loaded, try kickstart to restart it
    const kickstart = Bun.spawnSync(['launchctl', 'kickstart', '-k', `gui/${uid}/${name}`]);
    if (kickstart.exitCode === 0) {
      return { success: true };
    }
    const kickstartStderr = new TextDecoder().decode(kickstart.stderr).trim();
    return {
      success: false,
      error: `Failed to kickstart service: ${kickstartStderr || `exit code ${kickstart.exitCode}`}`,
    };
  }

  return {
    success: false,
    error: `Failed to bootstrap service: ${bootstrapStderr || `exit code ${bootstrap.exitCode}`}`,
  };
}

function unloadService(name: string, plistPath: string): ServiceResult {
  const uid = new TextDecoder().decode(Bun.spawnSync(['id', '-u']).stdout).trim();
  const bootout = Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${name}`]);

  if (bootout.exitCode === 0) {
    return { success: true };
  }

  // Bootout failed - check if not loaded (exit code 113 = "Could not find specified service")
  const bootoutStderr = new TextDecoder().decode(bootout.stderr).trim();
  const notLoaded = bootout.exitCode === 113 || bootoutStderr.includes('Could not find');

  if (notLoaded) {
    // Service wasn't loaded, that's fine
    return { success: true };
  }

  // Try legacy unload as fallback
  const unload = Bun.spawnSync(['launchctl', 'unload', plistPath]);
  if (unload.exitCode === 0) {
    return { success: true };
  }

  const unloadStderr = new TextDecoder().decode(unload.stderr).trim();
  return {
    success: false,
    error: `Failed to unload service: ${bootoutStderr || unloadStderr || `exit code ${bootout.exitCode}`}`,
  };
}

export async function serviceInstallCommand(interactive: boolean = true): Promise<void> {
  if (process.platform !== 'darwin') {
    if (interactive) {
      logger.error('Service installation is only supported on macOS.');
      process.exit(1);
    }
    return;
  }

  const binPath = getBinPathSafe();
  if (!binPath) {
    if (interactive) {
      logger.error('proton-drive-sync not found in PATH.');
      logger.error(
        'Install with: curl -fsSL https://www.damianb.dev/proton-drive-sync/install.sh | bash'
      );
      process.exit(1);
    }
    return;
  }

  // Create LaunchAgents directory if it doesn't exist
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }

  // Install proton-drive-sync service
  const installSync = interactive ? await askYesNo('Install proton-drive-sync service?') : true;
  if (installSync) {
    logger.info('Installing proton-drive-sync service...');
    if (existsSync(PLIST_PATH)) {
      unloadService(SERVICE_NAME, PLIST_PATH);
    }
    await Bun.write(PLIST_PATH, generateSyncPlist(binPath));
    logger.info(`Created: ${PLIST_PATH}`);
    setFlag(FLAGS.SERVICE_INSTALLED);
    if (loadSyncService()) {
      logger.info('proton-drive-sync service installed and started.');
    } else {
      logger.error('proton-drive-sync service installed but failed to start.');
    }
  } else {
    logger.info('Skipping proton-drive-sync service.');
  }
}

export async function serviceUninstallCommand(interactive: boolean = true): Promise<void> {
  if (process.platform !== 'darwin') {
    if (interactive) {
      logger.error('Service uninstallation is only supported on macOS.');
      process.exit(1);
    }
    return;
  }

  // Uninstall proton-drive-sync service
  if (existsSync(PLIST_PATH)) {
    const uninstallSync = interactive
      ? await askYesNo('Uninstall proton-drive-sync service?')
      : true;
    if (uninstallSync) {
      logger.info('Uninstalling proton-drive-sync service...');
      if (!unloadSyncService()) {
        logger.warn('Failed to unload service, continuing with uninstall...');
      }
      unlinkSync(PLIST_PATH);
      clearFlag(FLAGS.SERVICE_INSTALLED);
      logger.info('proton-drive-sync service uninstalled.');
    } else {
      logger.info('Skipping proton-drive-sync service.');
    }
  } else if (interactive) {
    logger.info('No service is installed.');
  }
}

/**
 * Check if the service is installed (using flag)
 */
export function isServiceInstalled(): boolean {
  return hasFlag(FLAGS.SERVICE_INSTALLED);
}

/**
 * Load the sync service (enable start on login)
 * Returns true on success, false on failure
 */
export function loadSyncService(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  if (!existsSync(PLIST_PATH)) {
    return false;
  }

  const result = loadService(SERVICE_NAME, PLIST_PATH);
  if (result.success) {
    setFlag(FLAGS.SERVICE_LOADED);
    logger.info('Service loaded: will start on login');
    return true;
  } else {
    logger.error(result.error ?? 'Failed to load service');
    return false;
  }
}

/**
 * Unload the sync service (disable start on login)
 * Returns true on success, false on failure
 */
export function unloadSyncService(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  if (!existsSync(PLIST_PATH)) {
    clearFlag(FLAGS.SERVICE_LOADED);
    return true;
  }

  const result = unloadService(SERVICE_NAME, PLIST_PATH);
  if (result.success) {
    clearFlag(FLAGS.SERVICE_LOADED);
    logger.info('Service unloaded: will not start on login');
    return true;
  } else {
    logger.error(result.error ?? 'Failed to unload service');
    return false;
  }
}

export function serviceUnloadCommand(): void {
  if (process.platform !== 'darwin') {
    logger.error('Service stop is only supported on macOS.');
    process.exit(1);
  }

  if (!unloadSyncService()) {
    logger.error('Failed to unload service.');
    process.exit(1);
  }
  sendSignal('stop');
  logger.info('Service stopped and unloaded. Run `proton-drive-sync service start` to restart.');
}

export function serviceLoadCommand(): void {
  if (process.platform !== 'darwin') {
    logger.error('Service start is only supported on macOS.');
    process.exit(1);
  }

  if (!existsSync(PLIST_PATH)) {
    logger.error('Service is not installed. Run `proton-drive-sync service install` first.');
    process.exit(1);
  }

  if (loadSyncService()) {
    logger.info('Service started.');
  } else {
    logger.error('Failed to start service.');
    process.exit(1);
  }
}
