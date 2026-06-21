/**
 * jobTracker.js — in-memory last-run/last-success/last-error recorder for
 * scheduled background jobs (football scheduler, prediction scheduler).
 *
 * Wraps an existing job function with `track(name, fn)` — purely an
 * observability layer, no change to the job's own logic. Read via
 * `getAll()` from the admin health endpoint.
 */

const jobs = new Map();

function track(name, fn) {
  return async (...args) => {
    const job = jobs.get(name) ?? {};
    job.lastRunAt = new Date().toISOString();
    jobs.set(name, job);
    try {
      const result = await fn(...args);
      job.lastSuccessAt = new Date().toISOString();
      job.lastError = null;
      return result;
    } catch (e) {
      job.lastError = e.message;
      job.lastErrorAt = new Date().toISOString();
      throw e;
    }
  };
}

function getAll() {
  return Array.from(jobs.entries()).map(([name, j]) => ({ name, ...j }));
}

module.exports = { track, getAll };
