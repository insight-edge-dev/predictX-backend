/**
 * iplService.js — IPL data layer (Highlightly-powered).
 *
 * Cache strategy (warehouse-first):
 *   NodeCache (10 min)
 *   → hl_fixtures / hl_standings tables in Supabase (permanent, no TTL discard)
 *   → Highlightly API (refreshes warehouse on fetch)
 *   → stale warehouse data if API is unreachable
 *
 * Data is NEVER discarded from Supabase. The warehouse grows with every
 * season. If Highlightly ever stops, the app serves from stored data.
 */

const hl      = require("./highlightlyService");
const storage = require("./highlightlyStorageService");
const sync    = require("./highlightlySyncService");
const {
  normalizeFixture,
  normalizeLiveDetail,
  normalizeStandings,
} = require("./highlightlyNormalizer");
const { getCache, setCache, delCache, TTL, KEYS } = require("./cacheService");
const { HL_CRICKET_LEAGUES } = require("../config/highlightlyConfig");

const SEASON    = Number(process.env.IPL_SEASON || 2026);
const IPL       = HL_CRICKET_LEAGUES.ipl;
const LEAGUE_ID = IPL?.seasons?.[SEASON] || "52875307";

// Refresh from API if DB data is older than 6 hours
const STALE_MS = 6 * 60 * 60_000;

// ── IPL fixtures ──────────────────────────────────────────────

async function getIPLFixtures() {
  // 1. NodeCache (10 min)
  const cached = getCache(KEYS.IPL_FIXTURES);
  if (cached) {
    console.log(`[IPL ${SEASON}] CACHE HIT (memory)`);
    return cached;
  }

  // 2. Warehouse DB
  const { fixtures, updatedAt, count } = await storage.getFixtures(LEAGUE_ID, SEASON);
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;

  if (count > 0 && ageMs < STALE_MS) {
    console.log(`[IPL ${SEASON}] WAREHOUSE HIT — ${count} fixtures (${Math.round(ageMs / 60_000)} min old)`);
    const enriched = await storage.enrichFixturesWithLogos(fixtures);
    setCache(KEYS.IPL_FIXTURES, enriched, TTL.FIXTURES);
    return enriched;
  }

  // 3. Highlightly API → refresh warehouse
  console.log(`[IPL ${SEASON}] fetching from Highlightly API`);
  try {
    const raw = await hl.getMatches({ leagueId: LEAGUE_ID, season: SEASON, limit: 100 });
    if (raw?.length) {
      const normalized = raw.map(normalizeFixture).filter(Boolean)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      void storage.storeFixtures(normalized);
      void storage.storeTeams(normalized.flatMap(f => [f.team1, f.team2]).filter(t => t?.id));

      const enriched = await storage.enrichFixturesWithLogos(normalized);
      setCache(KEYS.IPL_FIXTURES, enriched, TTL.FIXTURES);
      console.log(`[IPL ${SEASON}] API → ${normalized.length} fixtures stored`);
      return enriched;
    }
  } catch (e) {
    console.warn(`[IPL ${SEASON}] API error:`, e.message);
  }

  // 4. Serve stale warehouse data (never empty the app)
  if (count > 0) {
    console.warn(`[IPL ${SEASON}] serving stale warehouse data (${count} fixtures, ${Math.round(ageMs / 3_600_000)}h old)`);
    const enriched = await storage.enrichFixturesWithLogos(fixtures);
    setCache(KEYS.IPL_FIXTURES, enriched, TTL.FIXTURES);
    return enriched;
  }

  // Cache empty result for 30 min to avoid repeated API hammering
  setCache(KEYS.IPL_FIXTURES, [], 30 * 60);
  return [];
}

// ── Live matches ──────────────────────────────────────────────

async function getIPLLiveMatches() {
  const cached = getCache(KEYS.LIVE_MATCHES);
  if (cached) return cached;

  try {
    const today = new Date().toISOString().split("T")[0];
    const raw   = await hl.getMatches({ date: today });

    // Filter for IPL matches currently in play
    const liveRaw = (raw || []).filter(m =>
      String(m.league?.id) === String(LEAGUE_ID) &&
      m.state?.description === "In play"
    );

    // Enrich with live batting/bowling from match detail
    const live = await Promise.all(
      liveRaw.map(async m => {
        const fixture = normalizeFixture(m);
        if (!fixture) return null;
        try {
          const detail = await hl.getMatchDetail(m.id);
          return detail ? normalizeLiveDetail(detail, fixture) : fixture;
        } catch {
          return fixture;
        }
      })
    );

    const result = live.filter(Boolean).map(m => ({ ...m, status: "live" }));
    setCache(KEYS.LIVE_MATCHES, result, TTL.LIVE);
    return result;
  } catch (e) {
    console.warn(`[IPL ${SEASON}] live matches error:`, e.message);
    return [];
  }
}

// ── Combined matches (live + upcoming + completed) ────────────

async function getIPLMatches() {
  const [fixtures, live] = await Promise.all([
    getIPLFixtures(),
    getIPLLiveMatches(),
  ]);

  const liveIds    = new Set(live.map(m => m.id));
  const liveArr    = [...live];
  const upcoming   = [];
  const completed  = [];
  const seen       = new Set();
  const pastCutoffMs = Date.now() - 12 * 60 * 60_000;

  for (const m of fixtures) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (liveIds.has(m.id)) continue; // live version already in liveArr

    if (m.status === "live") {
      liveArr.push(m);
    } else if (m.status === "completed") {
      completed.push(m);
    } else {
      const matchMs = m.date ? new Date(m.date).getTime() : 0;
      if (matchMs && matchMs < pastCutoffMs) completed.push(m);
      else                                   upcoming.push(m);
    }
  }

  upcoming.sort((a, b)  => new Date(a.date) - new Date(b.date));
  completed.sort((a, b) => new Date(b.date) - new Date(a.date));

  console.log(`[IPL ${SEASON}] matches — live=${liveArr.length} upcoming=${upcoming.length} completed=${completed.length}`);
  return { live: liveArr, upcoming, completed };
}

// ── Points table ──────────────────────────────────────────────

async function getIPLTable() {
  const cached = getCache(KEYS.IPL_TABLE);
  if (cached) {
    console.log(`[IPL ${SEASON}] CACHE HIT — standings (memory)`);
    return cached;
  }

  // Warehouse
  const { standings, updatedAt } = await storage.getStandings(LEAGUE_ID, SEASON);
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;

  if (standings?.length && ageMs < STALE_MS) {
    console.log(`[IPL ${SEASON}] WAREHOUSE HIT — standings (${Math.round(ageMs / 60_000)} min old)`);
    setCache(KEYS.IPL_TABLE, standings, TTL.POINTS_TABLE);
    return standings;
  }

  // API
  const fresh = await sync.syncStandings(LEAGUE_ID, SEASON);
  if (fresh.length) {
    setCache(KEYS.IPL_TABLE, fresh, TTL.POINTS_TABLE);
    return fresh;
  }

  // Serve stale
  if (standings?.length) {
    console.warn(`[IPL ${SEASON}] serving stale standings`);
    setCache(KEYS.IPL_TABLE, standings, TTL.POINTS_TABLE);
    return standings;
  }

  return [];
}

// ── Cache management ──────────────────────────────────────────

async function resetIPLCache() {
  delCache(KEYS.IPL_FIXTURES);
  delCache(KEYS.IPL_TABLE);
  delCache(KEYS.LIVE_MATCHES);
  // Note: warehouse data is preserved — only NodeCache is cleared
  console.log("[IPL] NodeCache cleared (warehouse data preserved)");
}

module.exports = {
  getIPLFixtures,
  getIPLLiveMatches,
  getIPLMatches,
  getIPLTable,
  resetIPLCache,
};
