/**
 * Config Command - Open config file in nano
 */

import { spawnSync } from 'child_process';
import { ensureConfigDir, CONFIG_FILE } from '../config.js';

export function configCommand(): void {
    ensureConfigDir();
    spawnSync('nano', [CONFIG_FILE], { stdio: 'inherit' });
}
