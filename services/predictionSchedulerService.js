/**
 * predictionSchedulerService.js — pre-computes & stores PredictX picks for every
 * active (not-ended) cricket league other than IPL.
 *
 * IPL keeps its existing on-demand-then-persist flow via tipsService/tipsController
 * untouched. For the remaining cricket leagues (BBL, PSL, BPL, T20 Blast, T20 WC,
 * GSL, CSA T20) this job runs 3x/day, mirrors footballSchedulerService's cadence,
 * and writes to the SAME `pred:light:<id>` / `pred:full:<id>` Supabase cache rows
 * that getTipsList/getMatchTip already read from — so once this job has run, every
 * user request for these leagues is an instant DB hit, never a cold generation.
 *
 * "Active" = the league currently has at least one live or upcoming fixture.
 * Leagues with zero live/upcoming and some completed matches are "ended" — we
 * skip regenerating (existing stored predictions for their matches stay as-is).
 */

const { LEAGUES }   = require("../config/leaguesConfig");
const leagueService = require("./leagueService");
const genericTips   = require("./genericTipsService");
const db            = require("./dbService");
const jobTracker    = require("./jobTracker");

const REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000; // 24h / 3 = 8h, mirrors footballScheduler
const BOOT_DELAY_MS       = 30 * 1000;          // let the server finish booting first

let intervalHandle = null;

function isLeagueActive(matches) {
  return matches.live.length > 0 || matches.upcoming.length > 0;
}

async function ensureStored(match, table, completed, slug) {
  const lightKey = `pred:light:${match.id}`;
  const fullKey  = `pred:full:${match.id}`;

  try {
    const [existingLight, existingFull] = await Promise.all([
      db.getCachedData(lightKey, Infinity),
      db.getCachedData(fullKey, Infinity),
    ]);

    if (!existingLight) {
      const tip = await genericTips.getLightweightTip(match, table, completed, slug);
      if (tip) await db.setCachedData(lightKey, tip);
    }
    if (!existingFull) {
      const tip = await genericTips.getMatchTip(match, table, completed, slug);
      if (tip) await db.setCachedData(fullKey, { match, tip });
    }
  } catch (e) {
    console.warn(`[PredictionScheduler] ensureStored(${match.id}) failed —`, e.message);
  }
}

// Process matches in parallel batches to speed up DB writes while staying
// within Supabase free tier's connection limit (~60 PG connections via PgBouncer).
const MATCH_BATCH_SIZE = 5;

async function refreshLeague(slug) {
  const league = LEAGUES[slug];
  if (!league || slug === "ipl") return;

  try {
    const [matches, table] = await Promise.all([
      leagueService.getLeagueMatches(league),
      leagueService.getLeagueTable(league),
    ]);

    if (!isLeagueActive(matches)) {
      console.log(`[PredictionScheduler] ${slug}: no live/upcoming fixtures — season ended or not started, skipping`);
      return;
    }

    // Include completed matches too so prediction badges show for the full season,
    // mirroring how IPL's tips list behaves.
    const tippable = [...matches.live, ...matches.upcoming, ...matches.completed];
    if (tippable.length === 0) return;

    console.log(`[PredictionScheduler] ${slug}: ensuring PredictX picks for ${tippable.length} matches`);
    for (let i = 0; i < tippable.length; i += MATCH_BATCH_SIZE) {
      await Promise.all(
        tippable.slice(i, i + MATCH_BATCH_SIZE)
          .map(match => ensureStored(match, table, matches.completed, slug)),
      );
    }
  } catch (e) {
    console.warn(`[PredictionScheduler] ${slug} refresh failed —`, e.message);
  }
}

async function runRefresh() {
  console.log("[PredictionScheduler] running scheduled PredictX picks refresh…");
  const slugs = Object.keys(LEAGUES).filter(s => s !== "ipl");
  // Leagues are independent — run all in parallel, each processes its own matches
  await Promise.all(slugs.map(slug => refreshLeague(slug)));
  console.log("[PredictionScheduler] refresh complete");
  // Prune stale series-table rows on every cycle (news:detail >7d, pred >90d)
  void db.cleanupStaleSeriesRows();
}

/**
 * Starts the scheduler: one initial refresh shortly after boot, then every 8h.
 * Safe to call once at server startup.
 */
function start() {
  if (intervalHandle) return;

  const trackedRunRefresh = jobTracker.track("predictions:refresh", runRefresh);
  setTimeout(trackedRunRefresh, BOOT_DELAY_MS);
  intervalHandle = setInterval(trackedRunRefresh, REFRESH_INTERVAL_MS);

  console.log("[PredictionScheduler] started — refreshing PredictX picks for active non-IPL leagues every 8 hours (3x/day)");
}

module.exports = { start, runRefresh };
