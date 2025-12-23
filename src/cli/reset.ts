/**
 * Reset Command - Clear sync state from database
 */

import { confirm } from '@inquirer/prompts';
import { db, schema } from '../db/index.js';

export async function resetCommand(options: { yes: boolean; signals: boolean }): Promise<void> {
  const signalsOnly = options.signals;

  if (!options.yes) {
    const message = signalsOnly
      ? 'This will clear all signals from the database. Continue?'
      : 'This will reset the sync state, forcing proton-drive-sync to sync all files as if it were first launched. Continue?';

    const confirmed = await confirm({
      message,
      default: false,
    });

    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  }

  if (signalsOnly) {
    db.delete(schema.signals).run();
    console.log('Signals cleared.');
  } else {
    // Clear all sync-related tables
    db.delete(schema.clocks).run();
    db.delete(schema.syncJobs).run();
    db.delete(schema.processingQueue).run();
    console.log('State reset.');
  }
}
