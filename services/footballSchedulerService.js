/**
 * footballSchedulerService.js — keeps Supabase football data fresh by calling
 * the live football-data.org API exactly 3 times a day (every 8 hours).
 *
 * This is the ONLY trigger for football-data.org calls in the whole app —
 * user requests are always served from cache/DB (see footballService.js).
 * Free tier allows 10 req/min, so even running every 8h with 2 endpoint
 * calls per run (fixtures + standings) stays far under any limit.
 */

const footballService = require("./footballService");

const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000; // 24h / 3 = 8h
const BOOT_DELAY_MS       = 15 * 1000;          // let the server finish booting first

let intervalHandle = null;

async function runRefresh() {
  console.log("[FootballScheduler] running scheduled football-data.org refresh…");
  try {
    const result = await footballService.refreshFromAPI();
    console.log(`[FootballScheduler] refresh complete — ${result.fixtures} fixtures, ${result.groups} groups synced`);
  } catch (e) {
    console.warn("[FootballScheduler] refresh failed —", e.message);
  }
}

/**
 * Starts the scheduler: one initial refresh shortly after boot, then every 8h.
 * Safe to call once at server startup.
 */
function start() {
  if (intervalHandle) return;

  setTimeout(runRefresh, BOOT_DELAY_MS);
  intervalHandle = setInterval(runRefresh, REFRESH_INTERVAL_MS);

  console.log("[FootballScheduler] started — refreshing football data every 8 hours (3x/day)");
}

module.exports = { start };
