/**
 * Dashboard Server - Real-time sync status dashboard
 *
 * Provides SSE endpoints for live updates and JSON API for stats.
 * Runs on localhost:4242 during sync --watch.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { createReadStream, statSync, watchFile, unwatchFile } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { xdgState } from 'xdg-basedir';
import {
  getJobCounts,
  getRecentJobs,
  getBlockedJobs,
  getProcessingJobs,
  jobEvents,
  type JobEvent,
} from '../jobs.js';
import { logger } from '../logger.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DASHBOARD_PORT = 4242;
const LOG_FILE = join(xdgState || '', 'proton-drive-sync', 'sync.log');

// ============================================================================
// Hono App
// ============================================================================

const app = new Hono();

// Serve dashboard HTML at root
app.get('/', async (c) => {
  const html = await readFile(join(__dirname, 'index.html'), 'utf-8');
  return c.html(html);
});

// ============================================================================
// JSON API Endpoints
// ============================================================================

// GET /api/stats - Job queue counts
app.get('/api/stats', (c) => {
  const counts = getJobCounts();
  return c.json(counts);
});

// GET /api/jobs/recent - Recently synced jobs
app.get('/api/jobs/recent', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const jobs = getRecentJobs(limit);
  return c.json(jobs);
});

// GET /api/jobs/blocked - Blocked jobs
app.get('/api/jobs/blocked', (c) => {
  const jobs = getBlockedJobs();
  return c.json(jobs);
});

// GET /api/jobs/processing - Currently processing jobs
app.get('/api/jobs/processing', (c) => {
  const jobs = getProcessingJobs();
  return c.json(jobs);
});

// ============================================================================
// SSE Endpoints
// ============================================================================

// GET /api/events - SSE stream of job state changes
app.get('/api/events', async (c) => {
  return streamSSE(c, async (stream) => {
    const handler = (event: JobEvent) => {
      stream.writeSSE({
        event: 'job',
        data: JSON.stringify(event),
      });
    };

    jobEvents.on('job', handler);

    // Send initial stats
    await stream.writeSSE({
      event: 'stats',
      data: JSON.stringify(getJobCounts()),
    });

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' });
    }, 30000);

    // Cleanup on close
    stream.onAbort(() => {
      clearInterval(heartbeat);
      jobEvents.off('job', handler);
    });

    // Keep the stream open
    await new Promise(() => {});
  });
});

// GET /api/logs - SSE stream of log lines since connection
app.get('/api/logs', async (c) => {
  return streamSSE(c, async (stream) => {
    let fileSize = 0;

    try {
      fileSize = statSync(LOG_FILE).size;
    } catch {
      // File doesn't exist yet, start from 0
    }

    let currentPosition = fileSize;

    const sendNewLines = async () => {
      try {
        const stats = statSync(LOG_FILE);
        if (stats.size <= currentPosition) {
          // File was truncated or no new content
          if (stats.size < currentPosition) {
            currentPosition = 0; // Reset if truncated
          }
          return;
        }

        // Read new content from currentPosition
        const readStream = createReadStream(LOG_FILE, {
          start: currentPosition,
          end: stats.size - 1,
        });

        const rl = createInterface({ input: readStream });

        for await (const line of rl) {
          if (line.trim()) {
            await stream.writeSSE({
              event: 'log',
              data: line,
            });
          }
        }

        currentPosition = stats.size;
      } catch {
        // Ignore errors (file might not exist yet)
      }
    };

    // Watch for file changes
    const onFileChange = () => {
      sendNewLines();
    };

    watchFile(LOG_FILE, { interval: 500 }, onFileChange);

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' });
    }, 30000);

    // Cleanup on close
    stream.onAbort(() => {
      clearInterval(heartbeat);
      unwatchFile(LOG_FILE, onFileChange);
    });

    // Keep the stream open
    await new Promise(() => {});
  });
});

// ============================================================================
// Server Management
// ============================================================================

let server: ReturnType<typeof serve> | null = null;

export function startDashboard(): void {
  if (server) {
    logger.warn('Dashboard server already running');
    return;
  }

  server = serve({
    fetch: app.fetch,
    port: DASHBOARD_PORT,
  });

  logger.info(`Dashboard running at http://localhost:${DASHBOARD_PORT}`);
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
    logger.debug('Dashboard server stopped');
  }
}
