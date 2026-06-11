/**
 * footballService.js — Business logic for football data.
 *
 * Caching: NodeCache (hot) → Supabase DB (warm) → football-data.org (cold)
 * Free tier: 10 req/min — 3-tier cache keeps us well within limits.
 */

const api        = require("./footballAPIService");
const norm       = require("./footballNormalizer");
const { getCache, setCache, TTL, KEYS } = require("./cacheService");
const db         = require("./dbService");
const { ALL_FIXTURES } = require("../constants/wc2026Fixtures");

// ── Fixtures ──────────────────────────────────────────────────────

/**
 * Refresh statuses on hardcoded fixtures based on current time.
 * Once the API starts returning real data, this becomes a no-op.
 */
function refreshHardcodedFixtures() {
  const now = Date.now();
  return ALL_FIXTURES.map(f => {
    // Compute utcTime from date + time (stored in IST, convert back to UTC ms)
    // We stored the _utcMs on each fixture if we want; instead re-derive from date+time string.
    // Simpler: re-run the match() factory which recomputes status dynamically.
    // Since ALL_FIXTURES are already pre-built, just recompute status:
    const timeParts  = f.time.replace(" IST", "").split(":");
    const istH       = parseInt(timeParts[0], 10);
    const istM       = parseInt(timeParts[1], 10);
    const [y, mo, d] = f.date.split("-").map(Number);
    // IST → UTC: subtract 5h30m
    const utcMs      = Date.UTC(y, mo - 1, d, istH, istM) - (5.5 * 60 * 60 * 1000);
    const elapsed    = now - utcMs;
    const status     = elapsed < 0 ? "upcoming" : elapsed < 105 * 60 * 1000 ? "live" : "completed";
    const isLive     = status === "live";
    const isCompleted = status === "completed";
    return {
      ...f,
      status,
      statusText: isCompleted ? "FT" : isLive ? "LIVE" : "",
      score: {
        ...f.score,
        home: (isLive || isCompleted) ? (f.score.home ?? 0) : null,
        away: (isLive || isCompleted) ? (f.score.away ?? 0) : null,
      },
    };
  });
}

/**
 * Pulls fresh fixtures + standings from football-data.org and persists them
 * to NodeCache + Supabase (warm cache row + permanent reference tables).
 *
 * This is the ONLY place in the football pipeline that calls the live API —
 * it is invoked solely by the scheduled refresh job (3x/day, see
 * footballSchedulerService.js) or the `/admin/refresh-football` endpoint.
 * All user-facing reads (getWCFixtures/getGroups/getMatchById/...) are
 * served exclusively from cache/DB so we stay far under the free-tier
 * rate limit no matter how much traffic the app gets.
 */
async function refreshFromAPI() {
  const result = { fixtures: 0, groups: 0 };

  try {
    const raw = await api.getFixtures();
    const fixtures = raw.map(f => norm.normalizeFixture(f));
    if (fixtures.length > 0) {
      setCache(KEYS.FOOTBALL_FIXTURES, fixtures, TTL.FOOTBALL_FIXTURES);
      await db.setCachedData(KEYS.FOOTBALL_FIXTURES, fixtures);
      void db.syncFootballFixtures(fixtures);
      result.fixtures = fixtures.length;
    } else {
      console.warn("[Football] refreshFromAPI: fixtures endpoint returned no matches");
    }
  } catch (e) {
    console.warn("[Football] refreshFromAPI: fixtures refresh failed —", e.message);
  }

  try {
    const rawStandings = await api.getStandings();
    const groups = norm.normalizeGroups(rawStandings);
    if (Object.keys(groups).length > 0) {
      setCache(KEYS.FOOTBALL_GROUPS, groups, TTL.FOOTBALL_GROUPS);
      await db.setCachedData(KEYS.FOOTBALL_GROUPS, groups);
      void db.syncFootballGroups(groups);
      result.groups = Object.keys(groups).length;
    } else {
      console.log("[Football] refreshFromAPI: standings endpoint returned nothing yet (pre-tournament)");
    }
  } catch (e) {
    console.warn("[Football] refreshFromAPI: standings refresh failed —", e.message);
  }

  console.log(`[Football] refreshFromAPI — synced ${result.fixtures} fixtures, ${result.groups} groups`);
  return result;
}

/**
 * Full WC 2026 fixture list — served from NodeCache → Supabase only.
 * Never calls the live API (that's the scheduled job's job — see refreshFromAPI).
 * Falls back to the hardcoded fixture schedule until the first scheduled sync lands.
 */
async function getWCFixtures() {
  const cacheKey = KEYS.FOOTBALL_FIXTURES;

  // Only return cached data if it has real synced fixtures (not hardcoded fallback)
  const hot = getCache(cacheKey);
  if (hot && hot.length > 0 && !hot[0]?._hardcoded) return hot;

  // Treat Supabase as the long-lived source of truth — the scheduler keeps it
  // fresh, so we never want a stale-data check here to fall through to the API.
  const warm = await db.getCachedData(cacheKey, Infinity);
  if (warm && warm.length > 0 && !warm[0]?._hardcoded) {
    setCache(cacheKey, warm, TTL.FOOTBALL_FIXTURES);
    return warm;
  }

  // Nothing synced yet (fresh boot, before the first scheduled refresh) —
  // use the hardcoded schedule with live status recomputed.
  const hardcoded = refreshHardcodedFixtures();
  console.log(`[Football] getWCFixtures: no synced data yet — using ${hardcoded.length} hardcoded fixtures`);
  return hardcoded;
}

/**
 * Aggregated { live, upcoming, completed } — primary frontend endpoint.
 * Live is derived from status on each fixture (API doesn't have a separate live endpoint).
 */
async function getMatches() {
  const all = await getWCFixtures();

  const live      = all.filter(m => m.status === "live");
  const upcoming  = all
    .filter(m => m.status === "upcoming")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const completed = all
    .filter(m => m.status === "completed")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return { live, upcoming, completed };
}

/**
 * Live matches only — short 60s TTL for polling.
 * Derived from the full fixtures cache (no separate live endpoint).
 */
async function getLiveMatches() {
  const cacheKey = KEYS.FOOTBALL_LIVE;
  const hot = getCache(cacheKey);
  if (hot) return hot;

  const all  = await getWCFixtures();
  const live = all.filter(m => m.status === "live");

  setCache(cacheKey, live, TTL.FOOTBALL_LIVE);
  return live;
}

// ── Single match ──────────────────────────────────────────────────

/**
 * Single match detail — looked up from the synced fixtures list.
 * No dedicated live API call (football-data.org's per-match endpoint added
 * nothing of value — it returns the same fields as the bulk list, plus an
 * always-null `venue` pre-tournament — so it's not worth spending a request on).
 */
async function getMatchById(matchId) {
  const cacheKey = KEYS.FOOTBALL_MATCH(matchId);

  const hot = getCache(cacheKey);
  if (hot) return hot;

  const all = await getWCFixtures();
  const match = all.find(m => m.id === String(matchId)) ?? null;
  if (match) setCache(cacheKey, match, TTL.FOOTBALL_MATCH);
  return match;
}

// ── Group standings ───────────────────────────────────────────────

/**
 * Build pre-tournament groups from our WC2026_TEAMS registry.
 * Used as fallback before the API has standings (tournament not yet started).
 * Teams are in registry order (no ranking yet — all 0s).
 */
function buildPreTournamentGroups() {
  const { WC2026_TEAMS } = require("../constants/wc2026Teams");
  const groups = {};

  for (const team of Object.values(WC2026_TEAMS)) {
    if (!team.group) continue;
    const key = `Group ${team.group}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      rank:         groups[key].length + 1,
      team: {
        id:        team.shortName,
        name:      team.name,
        shortName: team.shortName,
        logo:      "",
        flag:      team.flag,
        color:     team.color,
      },
      played:       0,
      won:          0,
      drawn:        0,
      lost:         0,
      goalsFor:     0,
      goalsAgainst: 0,
      goalDiff:     0,
      points:       0,
      form:         "",
      qualified:    false,
    });
  }

  return groups;
}

/**
 * WC group standings bucketed by group letter — served from NodeCache → Supabase only.
 * Never calls the live API (that's the scheduled job's job — see refreshFromAPI).
 * Falls back to pre-tournament groups (0-0-0 records) until the first scheduled sync lands.
 */
async function getGroups() {
  const cacheKey = KEYS.FOOTBALL_GROUPS;

  // Only use cache if it has real data (non-empty)
  const hot = getCache(cacheKey);
  if (hot && Object.keys(hot).length > 0) return hot;

  // Treat Supabase as the long-lived source of truth — the scheduler keeps it
  // fresh, so we never want a stale-data check here to fall through to the API.
  const warm = await db.getCachedData(cacheKey, Infinity);
  if (warm && Object.keys(warm).length > 0) {
    setCache(cacheKey, warm, TTL.FOOTBALL_GROUPS);
    return warm;
  }

  // Nothing synced yet (fresh boot, before the first scheduled refresh) —
  // build from registry, don't cache (re-check each request)
  console.log("[Football] getGroups: no synced standings yet — using pre-tournament fallback");
  return buildPreTournamentGroups();
}

module.exports = {
  getMatches,
  getLiveMatches,
  getWCFixtures,
  getMatchById,
  getGroups,
  refreshFromAPI,
};
