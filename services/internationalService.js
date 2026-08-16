/**
 * internationalService.js — International & bilateral cricket series.
 *
 * In Highlightly, each bilateral tour (e.g. "England vs Bangladesh T20I") is
 * its own league entry with a unique ID. We don't need a "bucket" concept.
 *
 * "International" = any fixture whose leagueId is NOT in our known franchise/
 * domestic league registry (HL_CRICKET_LEAGUES). That set includes IPL, BBL,
 * PSL, TNPL, etc. Everything else — bilateral tours, ICC events, tri-series —
 * appears here automatically, with zero config change needed when a new tour starts.
 *
 * Data sources (priority order):
 *   1. hl_fixtures table — filled by highlightlySyncService every 60s (today)
 *      and every 24h (full active-league sweep). Also filled by syncUpcoming()
 *      which queries the next 7 days of API data.
 *   2. Highlightly API — direct call for today/tomorrow when warehouse is empty
 *      (first boot before any sync has run).
 */

const hl      = require("./highlightlyService");
const storage = require("./highlightlyStorageService");
const { normalizeFixture } = require("./highlightlyNormalizer");
const { getCache, setCache, TTL, KEYS } = require("./cacheService");
const { HL_CRICKET_LEAGUES } = require("../config/highlightlyConfig");
const supabase = require("../config/supabase");

// Build the set of all franchise/domestic league IDs (every season of every known league).
// Any fixture with a leagueId NOT in this set is treated as international.
const FRANCHISE_IDS = new Set(
  Object.values(HL_CRICKET_LEAGUES)
    .flatMap(l => Object.values(l.seasons).map(String))
);

function isInternational(fixture) {
  return !FRANCHISE_IDS.has(String(fixture.leagueId || ""));
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Helpers ───────────────────────────────────────────────────

function _uniqueTeams(matches) {
  const map = new Map();
  for (const m of matches) {
    if (m.team1?.id) map.set(String(m.team1.id), m.team1);
    if (m.team2?.id) map.set(String(m.team2.id), m.team2);
  }
  return [...map.values()];
}

function _buildSeriesSummary(leagueId, matches) {
  const liveCount      = matches.filter(m => m.status === "live").length;
  const completedCount = matches.filter(m => m.status === "completed").length;
  const status =
    liveCount > 0                       ? "live"
    : completedCount === matches.length ? "completed"
    : "upcoming";

  return {
    id:            String(leagueId),
    name:          matches[0].seriesLabel || matches[0].statusText || "International Series",
    format:        matches[0].format  || "T20",
    leagueSlug:    "intl",
    teams:         _uniqueTeams(matches),
    matchCount:    matches.length,
    completedCount,
    status,
    startDate:     matches[0].date,
    endDate:       matches[matches.length - 1].date,
  };
}

// ── Fetch today + N upcoming days from API, store everything ──

async function _fetchAndStoreDate(dateStr) {
  try {
    const raw = await hl.getMatches({ date: dateStr });
    if (!raw?.length) return [];
    const fixtures = raw.map(normalizeFixture).filter(Boolean);
    if (fixtures.length) await storage.storeFixtures(fixtures); // awaited — prevents 30 concurrent Supabase upserts
    return fixtures;
  } catch (e) {
    console.warn(`[Intl] _fetchAndStoreDate(${dateStr}) failed:`, e.message);
    return [];
  }
}

// ── Query warehouse for a date range ─────────────────────────

async function _queryWarehouse(fromStr, toStr) {
  try {
    const { data, error } = await supabase
      .from("hl_fixtures")
      .select("data, start_date")
      .gte("start_date", `${fromStr}T00:00:00.000Z`)
      .lte("start_date", `${toStr}T23:59:59.999Z`)
      .order("start_date", { ascending: true });

    if (error) throw error;
    return (data || []).map(r => r.data).filter(Boolean);
  } catch (e) {
    console.warn("[Intl] warehouse query failed:", e.message);
    return [];
  }
}

// ── Public: getScheduleFixtures ───────────────────────────────
// Returns { live, today, upcoming, completed } for home bundle.

async function getScheduleFixtures(daysAhead = 7) {
  const cacheKey = `intl:schedule:v2:${daysAhead}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const now         = Date.now();
  const todayStr    = new Date().toISOString().slice(0, 10);
  const cutoffStr   = new Date(now + daysAhead * 86_400_000).toISOString().slice(0, 10);
  const lookbackStr = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);

  // Try warehouse first
  let allFixtures = await _queryWarehouse(lookbackStr, cutoffStr);

  // If warehouse has nothing for today, hit the API directly (first boot)
  const todayInWarehouse = allFixtures.some(f => (f.date || "").slice(0, 10) === todayStr);
  if (!todayInWarehouse) {
    console.log("[Intl] warehouse empty for today — fetching from API");
    const apiToday = await _fetchAndStoreDate(todayStr);
    allFixtures = [...apiToday, ...allFixtures.filter(f => (f.date || "").slice(0, 10) !== todayStr)];
  }

  const intl = allFixtures.filter(isInternational);

  const live = [], today = [], upcoming = [], completed = [];
  for (const m of intl) {
    const dateStr = (m.date || "").slice(0, 10);
    if (m.status === "live") {
      live.push(m);
    } else if (m.status === "completed") {
      if (dateStr >= lookbackStr && dateStr <= todayStr) completed.push(m);
    } else {
      if (dateStr === todayStr)                        today.push(m);
      else if (dateStr > todayStr && dateStr <= cutoffStr) upcoming.push(m);
    }
  }

  today.sort((a, b)     => new Date(a.date) - new Date(b.date));
  upcoming.sort((a, b)  => new Date(a.date) - new Date(b.date));
  completed.sort((a, b) => new Date(b.date) - new Date(a.date));

  const result = { live, today, upcoming, completed };
  setCache(cacheKey, result, 5 * 60); // 5-min NodeCache (sync service refreshes warehouse every 60s)
  console.log(`[Intl] schedule: live=${live.length} today=${today.length} upcoming=${upcoming.length} completed=${completed.length}`);
  return result;
}

// ── Public: getSeriesList ─────────────────────────────────────
// Returns series grouped by leagueId for the "International Series" section.

async function getSeriesList() {
  const cacheKey = "intl:series:list:v2";
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const now     = Date.now();
  const fromStr = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
  const toStr   = new Date(now + 60 * 86_400_000).toISOString().slice(0, 10);

  let allFixtures = await _queryWarehouse(fromStr, toStr);

  // Fallback to API for today if warehouse is empty
  if (!allFixtures.length) {
    const todayStr = new Date().toISOString().slice(0, 10);
    allFixtures = await _fetchAndStoreDate(todayStr);
  }

  const intl = allFixtures.filter(isInternational);
  if (!intl.length) return [];

  // Group by leagueId → one "series" per unique league ID
  const groups = new Map();
  for (const m of intl) {
    const key = String(m.leagueId || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const series = [...groups.entries()]
    .map(([leagueId, matches]) => {
      matches.sort((a, b) => new Date(a.date) - new Date(b.date));
      return _buildSeriesSummary(leagueId, matches);
    })
    .filter(s => s.matchCount > 0);

  const rank = { live: 0, upcoming: 1, completed: 2 };
  series.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    const ad = new Date(a.startDate).getTime();
    const bd = new Date(b.startDate).getTime();
    return a.status === "completed" ? bd - ad : ad - bd;
  });

  setCache(cacheKey, series, TTL.INTL_SERIES);
  console.log(`[Intl] series list: ${series.length} active/upcoming series`);
  return series;
}

// ── Public: getAllCricketSeries ───────────────────────────────
// Returns ALL cricket series from the warehouse — franchise AND international —
// grouped by leagueId. Used by the "World Cricket" screen to show everything.

async function getAllCricketSeries() {
  const cacheKey = "all:cricket:series:v1";
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const now     = Date.now();
  const fromStr = new Date(now - 180 * 86_400_000).toISOString().slice(0, 10); // 6 months back
  const toStr   = new Date(now + 180 * 86_400_000).toISOString().slice(0, 10); // 6 months ahead

  let allFixtures = await _queryWarehouse(fromStr, toStr);

  if (!allFixtures.length) {
    const todayStr = new Date().toISOString().slice(0, 10);
    allFixtures = await _fetchAndStoreDate(todayStr);
  }

  if (!allFixtures.length) return [];

  // Group ALL fixtures by leagueId (no isInternational filter)
  const groups = new Map();
  for (const m of allFixtures) {
    const key = String(m.leagueId || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const series = [...groups.entries()]
    .map(([leagueId, matches]) => {
      matches.sort((a, b) => new Date(a.date) - new Date(b.date));
      const isFranchise = FRANCHISE_IDS.has(leagueId);

      const liveCount      = matches.filter(m => m.status === "live").length;
      const completedCount = matches.filter(m => m.status === "completed").length;
      const status =
        liveCount > 0                       ? "live"
        : completedCount === matches.length ? "completed"
        : "upcoming";

      return {
        id:            leagueId,
        name:          matches[0].seriesLabel || matches[0].leagueName || "Cricket Series",
        format:        matches[0].format  || "T20",
        leagueSlug:    isFranchise ? (matches[0].leagueName || "franchise") : "intl",
        isFranchise,
        teams:         _uniqueTeams(matches),
        matchCount:    matches.length,
        completedCount,
        liveCount,
        status,
        startDate:     matches[0].date,
        endDate:       matches[matches.length - 1].date,
        leagueLogo:    matches[0].leagueLogo || "",
      };
    })
    .filter(s => s.matchCount > 0);

  const rank = { live: 0, upcoming: 1, completed: 2 };
  series.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    const ad = new Date(a.startDate).getTime();
    const bd = new Date(b.startDate).getTime();
    return a.status === "completed" ? bd - ad : ad - bd;
  });

  setCache(cacheKey, series, 5 * 60);
  console.log(`[Intl] all cricket series: ${series.length} total`);
  return series;
}

// ── Public: getSeriesDetail ───────────────────────────────────
// Returns matches for a specific series (by Highlightly leagueId used as series id).

async function getSeriesDetail(stageId) {
  const now     = Date.now();
  const fromStr = new Date(now - 365 * 86_400_000).toISOString().slice(0, 10); // full season history
  const toStr   = new Date(now + 180 * 86_400_000).toISOString().slice(0, 10);

  const allFixtures = await _queryWarehouse(fromStr, toStr);
  const matches = allFixtures
    .filter(m => String(m.leagueId) === String(stageId))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!matches.length) return null;

  const live      = matches.filter(m => m.status === "live");
  const upcoming  = matches.filter(m => m.status === "upcoming");
  const completed = matches.filter(m => m.status === "completed").reverse();

  return {
    series: {
      id:         String(stageId),
      name:       matches[0].seriesLabel || "International Series",
      format:     matches[0].format || "T20",
      leagueSlug: "intl",
      teams:      _uniqueTeams(matches),
      matchCount: matches.length,
    },
    matches: { live, upcoming, completed },
  };
}

// ── Public: findMatch ─────────────────────────────────────────
// Look up a single match by id across all international fixtures.

async function findMatch(matchId) {
  const { data } = await supabase
    .from("hl_fixtures")
    .select("data")
    .eq("id", String(matchId))
    .single()
    .catch(() => ({ data: null }));

  if (!data?.data) return null;
  const fixture = data.data;
  return { match: fixture, fixtures: [fixture], leagueId: fixture.leagueId };
}

// ── Public: syncUpcomingMatches ───────────────────────────────
// Fetches next N days from the API so upcoming bilateral series appear in the warehouse.
// Called by highlightlySyncService on boot + daily.

async function syncUpcomingMatches(days = 7) {
  console.log(`[Intl] syncing upcoming ${days} days from Highlightly`);
  const results = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
    const fixtures = await _fetchAndStoreDate(d);
    results.push(...fixtures.filter(isInternational));
    await _delay(300);
  }
  console.log(`[Intl] upcoming sync complete: ${results.length} international fixtures found`);
  return results;
}

// ── Backward-compat exports ───────────────────────────────────
// resolverService and internationalController expect these names.

async function getActiveBuckets() { return []; } // no longer used
async function getBucketFixtures() { return []; }
async function getLeagueIdForSlug() { return null; }
function effectiveStatus(m) { return m.status || "upcoming"; }
const INTERNATIONAL_LEAGUES = {};

module.exports = {
  INTERNATIONAL_LEAGUES,
  getActiveBuckets,
  getBucketFixtures,
  getLeagueIdForSlug,
  getSeriesList,
  getAllCricketSeries,
  getSeriesDetail,
  getScheduleFixtures,
  findMatch,
  effectiveStatus,
  syncUpcomingMatches,
  isInternational,
};
