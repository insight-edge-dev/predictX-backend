/**
 * worker.js — Sync worker process.
 *
 * Runs ALL background data sync jobs. Completely separate from the HTTP server
 * (server.js) so heavy sync work never starves incoming API requests for CPU.
 *
 * Start:
 *   node worker.js          (production)
 *   nodemon worker.js       (development)
 *
 * In dev, use `npm run dev` which starts both server + worker via concurrently.
 *
 * Architecture:
 *   server.js  → HTTP only, reads warehouse, zero sync logic
 *   worker.js  → sync only, writes warehouse, zero HTTP
 *   Supabase   → shared warehouse between both processes
 *
 * Graceful shutdown (SIGTERM / SIGINT):
 *   1. Stop scheduling new sync jobs
 *   2. Drain the write queue (finish any in-progress Supabase writes)
 *   3. Exit cleanly
 */

require("dotenv").config();

const highlightlySync  = require("./services/highlightlySyncService");
const { dbWriteQueue } = require("./services/dbWriteQueue");
const { markStuckJobsFailed, updateWorkerHeartbeat } = require("./services/syncLogger");

console.log("[Worker] PredictX sync worker starting...");

// Mark any jobs left as 'running' from a previous crash as failed before starting new ones
markStuckJobsFailed(5).catch(() => {});

// Liveness heartbeat — written every 60 s so /api/health can report worker status
updateWorkerHeartbeat().catch(() => {});
const _heartbeatInterval = setInterval(() => updateWorkerHeartbeat().catch(() => {}), 60_000);

highlightlySync.start();

// ── Graceful shutdown ─────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[Worker] ${signal} received — stopping sync jobs`);
  clearInterval(_heartbeatInterval);
  highlightlySync.stop();

  // Drain the write queue so no in-flight Supabase write is cut short
  if (dbWriteQueue.depth > 0) {
    console.log(`[Worker] draining write queue (${dbWriteQueue.depth} writes pending)...`);
    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (dbWriteQueue.depth === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
      // Hard timeout: force exit after 15s even if queue isn't drained
      setTimeout(() => { clearInterval(interval); resolve(); }, 15_000);
    });
  }

  console.log("[Worker] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[Worker] uncaughtException:", err.message, err.stack);
  // Don't exit — sync jobs should survive non-fatal errors
});

process.on("unhandledRejection", (reason) => {
  console.error("[Worker] unhandledRejection:", reason);
});
