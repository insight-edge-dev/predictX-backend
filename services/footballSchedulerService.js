/**
 * footballSchedulerService.js — keeps football data fresh via two independent
 * loops:
 *
 *  1. Full sync, every 8 hours — fixtures + standings, plus a throttled
 *     backfill of goal events for live/newly-completed matches (up to ~20
 *     calls, 7s apart). This is the only loop that writes to Supabase.
 *     See footballService.refreshFromAPI/enrichWithEvents.
 *
 *  2. Live-score poll, every 60 seconds — a single lightweight call that
 *     updates ONLY status/score/minute on whichever matches are (or were)
 *     live. Without this, a live match's score/clock would stay frozen at
 *     whatever it was during the last full sync for up to 8 hours — which
 *     is exactly what users were seeing before this loop existed.
 *     NodeCache-only; never touches Supabase. See footballService.refreshLiveScores.
 *
 * Both loops call football-data.org directly — these are the ONLY triggers
 * for football-data.org calls in the whole app; user requests are always
 * served from cache/DB. Free tier allows 10 req/min: the live poll uses 1
 * call/min and the full sync's backfill is throttled, so combined usage
 * stays far under any limit.
 */

const footballService = require("./footballService");
const jobTracker      = require("./jobTracker");

const FULL_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h — shorter during active tournament
const LIVE_POLL_INTERVAL_MS    = 60 * 1000;          // 60s
const BOOT_DELAY_MS            = 15 * 1000;          // let the server finish booting first

let fullIntervalHandle = null;
let liveIntervalHandle = null;

// Tracked at the service-call level (not the outer runX wrapper) so
// jobTracker sees the real success/failure before the existing try/catch
// here swallows it for logging purposes.
const trackedRefreshFromAPI   = jobTracker.track("football:fullRefresh", footballService.refreshFromAPI);
const trackedRefreshLiveScores = jobTracker.track("football:livePoll",   footballService.refreshLiveScores);

async function runFullRefresh() {
  console.log("[FootballScheduler] running scheduled football-data.org full refresh…");
  try {
    const result = await trackedRefreshFromAPI();
    console.log(`[FootballScheduler] full refresh complete — ${result.fixtures} fixtures, ${result.groups} groups synced`);
  } catch (e) {
    console.warn("[FootballScheduler] full refresh failed —", e.message);
  }
}

async function runLivePoll() {
  try {
    const updated = await trackedRefreshLiveScores();
    if (updated > 0) console.log(`[FootballScheduler] live poll — ${updated} match(es) updated`);
  } catch (e) {
    console.warn("[FootballScheduler] live poll failed —", e.message);
  }
}

/**
 * Starts both loops: one initial full refresh shortly after boot then every
 * 8h, and a live-score poll every 60s. Safe to call once at server startup.
 */
function start() {
  if (fullIntervalHandle) return;

  setTimeout(runFullRefresh, BOOT_DELAY_MS);
  fullIntervalHandle = setInterval(runFullRefresh, FULL_REFRESH_INTERVAL_MS);
  liveIntervalHandle = setInterval(runLivePoll, LIVE_POLL_INTERVAL_MS);

  console.log("[FootballScheduler] started — full refresh every 8h, live-score poll every 60s");
}

module.exports = { start };
