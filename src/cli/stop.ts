/**
 * Stop Command
 *
 * Stops a running proton-drive-sync process gracefully.
 */

import { sendSignal, hasSignal, consumeSignal, isAlreadyRunning } from '../signals.js';

/**
 * Stop the sync process gracefully by sending a stop signal.
 * The process will detect this signal and exit cleanly (exit code 0),
 * which means launchd won't restart it (due to KeepAlive.SuccessfulExit: false).
 */
export function stopCommand(): void {
  // Check if a sync process is running first
  if (!isAlreadyRunning()) {
    console.log('No running proton-drive-sync process found.');
    return;
  }

  // Send stop signal to the process
  sendSignal('stop');
  console.log('Stop signal sent. Waiting for process to exit...');

  // Wait for up to 15 seconds for the process to exit
  const startTime = Date.now();
  const timeout = 15000;
  const checkInterval = 100;

  const waitForExit = (): void => {
    // Check if signal was consumed (process handled it and exited)
    if (!hasSignal('stop')) {
      console.log('proton-drive-sync stopped.');
      return;
    }

    if (Date.now() - startTime < timeout) {
      setTimeout(waitForExit, checkInterval);
    } else {
      // Timeout - consume signal and report
      consumeSignal('stop');
      console.log('No running proton-drive-sync process found (or it did not respond).');
    }
  };

  waitForExit();
}
