/**
 * syncLogger.js — Sync job observability.
 *
 * withSyncLog(jobName, fn) wraps any sync function so each run is
 * recorded in the sync_jobs Supabase table:
 *   - started_at, finished_at, duration_ms
 *   - rows_written (returned by fn as { count: N } or array.length)
 *   - status: 'running' | 'done' | 'failed'
 *   - error: message on failure
 *
 * Only use for infrequent jobs (hourly/daily/weekly).
 * Do NOT wrap syncTodayMatches (runs every 60s) — the log table would grow
 * too large and generate unnecessary Supabase writes.
 *
 * Required Supabase table (run sync_jobs_migration.sql):
 *   create table sync_jobs (
 *     id          bigserial primary key,
 *     job_name    text not null,
 *     started_at  timestamptz default now(),
 *     finished_at timestamptz,
 *     duration_ms int,
 *     rows_written int default 0,
 *     status      text default 'running',
 *     error       text
 *   );
 */

const supabase = require("../config/supabase");

/**
 * On worker startup, mark any sync_jobs rows still in 'running' status
 * that started more than `olderThanMinutes` ago as failed.
 * Prevents the dashboard from showing zombie "running" jobs after a crash.
 */
async function markStuckJobsFailed(olderThanMinutes = 5) {
  try {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    await supabase
      .from("sync_jobs")
      .update({
        status:      "failed",
        finished_at: new Date().toISOString(),
        error:       "Worker restarted — job was interrupted",
      })
      .eq("status", "running")
      .lt("started_at", cutoff);
    console.log("[SyncLogger] cleaned up any stuck sync_jobs rows");
  } catch (e) {
    console.warn("[SyncLogger] markStuckJobsFailed:", e.message);
  }
}

/**
 * Called by worker.js every 60 s to record liveness.
 * Requires the worker_heartbeat table (see worker_heartbeat_migration.sql).
 */
async function updateWorkerHeartbeat() {
  try {
    await supabase
      .from("worker_heartbeat")
      .upsert({ id: 1, last_seen: new Date().toISOString(), worker_pid: process.pid });
  } catch {
    // table might not exist yet — silently skip
  }
}

/**
 * Read the latest worker heartbeat — used by /api/health.
 * Returns { last_seen, worker_pid } or null if the table doesn't exist.
 */
async function getWorkerStatus() {
  try {
    const { data } = await supabase
      .from("worker_heartbeat")
      .select("last_seen, worker_pid")
      .eq("id", 1)
      .single();
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap a sync function with start/finish logging.
 * @param {string} jobName   — displayed in /api/health
 * @param {() => Promise<any>} fn  — returns { count: N }, array, or void
 */
async function withSyncLog(jobName, fn) {
  const startMs = Date.now();
  let id = null;

  try {
    const { data } = await supabase
      .from("sync_jobs")
      .insert({ job_name: jobName, status: "running" })
      .select("id")
      .single();
    id = data?.id ?? null;
  } catch {
    // sync_jobs table might not exist yet — degrade gracefully, never block the job
  }

  try {
    const result    = await fn();
    const duration  = Date.now() - startMs;
    const rows      = Array.isArray(result)   ? result.length
                    : result?.count != null   ? result.count
                    : 0;

    if (id) {
      await supabase.from("sync_jobs").update({
        status:      "done",
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        rows_written: rows,
      }).eq("id", id).catch(() => {});
    }

    console.log(`[Sync] ${jobName} done in ${(duration / 1000).toFixed(1)}s (${rows} rows)`);
    return result;
  } catch (e) {
    const duration = Date.now() - startMs;

    if (id) {
      await supabase.from("sync_jobs").update({
        status:      "failed",
        finished_at: new Date().toISOString(),
        duration_ms: duration,
        error:       e.message,
      }).eq("id", id).catch(() => {});
    }

    console.error(`[Sync] ${jobName} FAILED after ${(duration / 1000).toFixed(1)}s:`, e.message);
    throw e;
  }
}

/**
 * Fetch recent job history — used by /api/health.
 */
async function getRecentJobs(limit = 30) {
  try {
    const { data } = await supabase
      .from("sync_jobs")
      .select("id, job_name, status, started_at, finished_at, duration_ms, rows_written, error")
      .order("started_at", { ascending: false })
      .limit(limit);
    return data || [];
  } catch {
    return [];
  }
}

module.exports = { withSyncLog, getRecentJobs, markStuckJobsFailed, updateWorkerHeartbeat, getWorkerStatus };
