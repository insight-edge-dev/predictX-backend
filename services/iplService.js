/**
 * iplService.js — IPL data layer (Sportsmonks-powered).
 *
 * Single data source: Sportsmonks Cricket API v2.
 * No more CricketData quota limits. No more matchKey collision hacks.
 *
 * Cache strategy:
 *   Fixtures list  — NodeCache 10 min  + DB 6 h
 *   Standings      — NodeCache 6 h     + DB 6 h
 *   Live scores    — NodeCache 30 s    (never DB)
 */

const sm  = require("./sportmonksService");
const db  = require("./dbService");
const {
  normalizeFixture,
  normalizeStandings,
} = require("./sportmonksNormalizer");
const { getCache, setCache, delCache, TTL, KEYS } = require("./cacheService");

const SEASON = String(process.env.IPL_SEASON || "2026");

// DB cache keys
const DB_FIXTURES_KEY  = `ipl:fixtures:${SEASON}`;
const DB_TABLE_KEY     = `ipl:table:${SEASON}`;

// ── IPL fixtures (full season schedule) ───────────────────────
// NodeCache 10 min → DB 6 h → Sportsmonks API

async function getIPLFixtures() {
  // 1. NodeCache
  const mem = getCache(KEYS.IPL_FIXTURES);
  if (mem) {
    console.log(`[IPL ${SEASON}] CACHE USED — fixtures (memory)`);
    return mem;
  }

  // 2. DB (6 h TTL)
  const dbHit = await db.getCachedData(DB_FIXTURES_KEY, 6 * 60 * 60_000);
  if (dbHit) {
    console.log(`[IPL ${SEASON}] CACHE USED — fixtures (DB)`);
    setCache(KEYS.IPL_FIXTURES, dbHit, TTL.FIXTURES);
    return dbHit;
  }

  // 3. API
  console.log(`[IPL ${SEASON}] FETCH START — fixtures from Sportsmonks`);
  const raw = await sm.getIPLFixtures();
  if (!raw || !Array.isArray(raw)) {
    console.warn(`[IPL ${SEASON}] fixtures: no data from API`);
    return [];
  }

  const fixtures = raw
    .map(normalizeFixture)
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  console.log(`[IPL ${SEASON}] fixtures ready: ${fixtures.length} matches`);
  setCache(KEYS.IPL_FIXTURES, fixtures, TTL.FIXTURES);
  void db.setCachedData(DB_FIXTURES_KEY, fixtures);
  void db.syncCricketReferenceData(fixtures);
  return fixtures;
}

// ── Live matches ──────────────────────────────────────────────
// Polls Sportsmonks /livescores, filters for IPL season.
// NodeCache 30 s only.

async function getIPLLiveMatches() {
  const mem = getCache(KEYS.LIVE_MATCHES);
  if (mem) return mem;

  const raw = await sm.getLivescores();
  if (!Array.isArray(raw)) return [];

  const live = raw
    .filter(f => f.season_id === sm.IPL_SEASON_ID)
    .map(normalizeFixture)
    .filter(Boolean)
    .map(m => ({ ...m, status: "live" }));

  setCache(KEYS.LIVE_MATCHES, live, TTL.LIVE);
  return live;
}

// ── IPL matches (live + upcoming + completed) ─────────────────
// Builds from fixtures list + merges live scores on top.

async function getIPLMatches() {
  const [fixtures, live] = await Promise.all([
    getIPLFixtures(),
    getIPLLiveMatches(),
  ]);

  const liveIds = new Set(live.map(m => m.id));

  const liveIPL      = [...live];
  const upcomingIPL  = [];
  const completedIPL = [];
  const seenIds      = new Set();

  for (const m of fixtures) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);

    // Live match from livescores overrides fixture status
    if (liveIds.has(m.id)) continue; // already in liveIPL

    if (m.status === "live") {
      liveIPL.push(m);
    } else if (m.status === "completed") {
      completedIPL.push(m);
    } else {
      upcomingIPL.push(m);
    }
  }

  upcomingIPL.sort((a, b)  => new Date(a.date) - new Date(b.date));
  completedIPL.sort((a, b) => new Date(b.date) - new Date(a.date));

  const result = { live: liveIPL, upcoming: upcomingIPL, completed: completedIPL };
  console.log(`[IPL ${SEASON}] matches — live=${liveIPL.length} upcoming=${upcomingIPL.length} completed=${completedIPL.length}`);
  return result;
}

// ── IPL points table ──────────────────────────────────────────
// NodeCache 6 h → DB 6 h → Sportsmonks standings API

async function getIPLTable() {
  // 1. NodeCache
  const mem = getCache(KEYS.IPL_TABLE);
  if (mem) {
    console.log(`[IPL ${SEASON}] CACHE USED — table (memory)`);
    return mem;
  }

  // 2. DB
  const dbHit = await db.getCachedData(DB_TABLE_KEY, 6 * 60 * 60_000);
  if (dbHit) {
    console.log(`[IPL ${SEASON}] CACHE USED — table (DB)`);
    setCache(KEYS.IPL_TABLE, dbHit, TTL.POINTS_TABLE);
    return dbHit;
  }

  // 3. API
  console.log(`[IPL ${SEASON}] FETCH START — standings from Sportsmonks`);
  const { regular } = await sm.getIPLStandings();
  const table = normalizeStandings(regular);

  if (table.length > 0) {
    setCache(KEYS.IPL_TABLE, table, TTL.POINTS_TABLE);
    void db.setCachedData(DB_TABLE_KEY, table);
    console.log(`[IPL ${SEASON}] table ready: ${table.length} teams`);
  }
  return table;
}

// ── Cache reset (admin) ───────────────────────────────────────

async function resetIPLCache() {
  delCache(KEYS.IPL_FIXTURES);
  delCache(KEYS.IPL_TABLE);
  delCache(KEYS.LIVE_MATCHES);
  await Promise.all([
    db.deleteFixtures(DB_FIXTURES_KEY),
    db.deleteFixtures(DB_TABLE_KEY),
  ]);
  console.log("[IPL] cache reset");
}

module.exports = {
  getIPLFixtures,
  getIPLLiveMatches,
  getIPLMatches,
  getIPLTable,
  resetIPLCache,
};
