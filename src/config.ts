/**
 * Proton Drive Sync - Configuration
 *
 * Reads config from ~/.config/proton-drive-sync/config.json
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { xdgConfig } from 'xdg-basedir';

// ============================================================================
// Types
// ============================================================================

export interface SyncDir {
  source_path: string;
  remote_root: string;
}

export interface Config {
  sync_dirs: SyncDir[];
  sync_concurrency: number;
}

// ============================================================================
// Constants
// ============================================================================

if (!xdgConfig) {
  console.error('Could not determine XDG config directory');
  process.exit(1);
}

const CONFIG_DIR = join(xdgConfig, 'proton-drive-sync');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export { CONFIG_DIR, CONFIG_FILE };

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// ============================================================================
// Config Loading
// ============================================================================

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`Config file not found: ${CONFIG_FILE}`);
    console.error(
      'Create it with: {"sync_dirs": [{"source_path": "/path/to/dir", "remote_root": "backup"}]}'
    );
    process.exit(1);
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as Config;

    if (!config.sync_dirs || !Array.isArray(config.sync_dirs)) {
      console.error('Config must have a "sync_dirs" array');
      process.exit(1);
    }

    if (config.sync_dirs.length === 0) {
      console.error('Config "sync_dirs" array is empty');
      process.exit(1);
    }

    // Default sync_concurrency to 8 if not set
    if (config.sync_concurrency === undefined) {
      config.sync_concurrency = 8;
    }

    // Validate all sync_dirs entries
    for (const dir of config.sync_dirs) {
      if (typeof dir === 'string') {
        console.error(
          'Config sync_dirs must be objects with "source_path" and "remote_root" properties'
        );
        console.error(
          'Example: {"sync_dirs": [{"source_path": "/path/to/dir", "remote_root": "backup"}]}'
        );
        process.exit(1);
      }
      if (!dir.source_path) {
        console.error('Each sync_dirs entry must have a "source_path" property');
        process.exit(1);
      }
      if (!existsSync(dir.source_path)) {
        console.error(`Sync directory does not exist: ${dir.source_path}`);
        process.exit(1);
      }
      // Default remote_root to empty string if not set
      if (dir.remote_root === undefined) {
        dir.remote_root = '';
      }
    }

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`Config file not found: ${CONFIG_FILE}`);
    } else if (error instanceof SyntaxError) {
      console.error(`Invalid JSON in config file: ${CONFIG_FILE}`);
    } else {
      console.error(`Error reading config: ${(error as Error).message}`);
    }
    process.exit(1);
  }
}
