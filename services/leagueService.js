/**
 * leagueService.js — Generic data layer for ALL leagues (Highlightly-powered).
 *
 * This is the main service for every league the app supports: IPL, PSL, BBL,
 * BPL, T20 Blast, T20 World Cup, ISL, La Liga, bilateral series, state leagues,
 * and any other league added in future. It replaces the old Sportsmonks-backed
 * implementation entirely.
 *
 * Called from controllers with a league config object from leaguesConfig.js.
 * The slug is the bridge between leaguesConfig.js and highlightlyConfig.js.
 *
 * Cache strategy (warehouse-first, same as iplService):
 *   NodeCache (10 min)
 *   → hl_* Supabase tables (permanent warehouse — no TTL discard)
 *   → Highlightly API (refreshes warehouse on fetch)
 *   → stale warehouse data if API is unreachable
 *
 * Data is NEVER discarded from Supabase. The warehouse grows with every season.
 */

const hl      = require("./highlightlyService");
const storage = require("./highlightlyStorageService");
const sync    = require("./highlightlySyncService");
const {
  normalizeFixture,
  normalizeFootballFixture,
  normalizeLiveDetail,
  normalizeStandings,
} = require("./highlightlyNormalizer");
const { getCache, setCache, delCache, TTL } = require("./cacheService");
const {
  HL_CRICKET_LEAGUES,
  HL_FOOTBALL_LEAGUES,
  getHLLeagueId,
} = require("../config/highlightlyConfig");

// Refresh from API if DB data is older than 6 hours
const STALE_MS = 6 * 60 * 60_000;

// TTL for the shared "today's matches" cache — all leagues read from one API call.
// syncTodayMatches seeds this key every 60s so individual league calls almost
// always find a cache hit and make zero extra API requests.
const TODAY_CACHE_TTL = 90; // seconds

async function _getTodayRaw(sport) {
  const key = `hl:today:${sport}`;
  const mem = getCache(key);
  if (mem) return mem;

  const today = new Date().toISOString().split("T")[0];
  try {
    const raw = sport === "football"
      ? await hl.getFootballMatches({ date: today })
      : await hl.getMatches({ date: today });
    const arr = Array.isArray(raw) ? raw : (raw?.data ?? []);
    setCache(key, arr, TODAY_CACHE_TTL);
    return arr;
  } catch (e) {
    console.warn(`[League] _getTodayRaw(${sport}) failed:`, e.message);
    return [];
  }
}

// ── League ID resolution ──────────────────────────────────────
// Maps a leaguesConfig.js league object → Highlightly leagueId string.
// Returns null if the slug isn't registered in highlightlyConfig.js yet.

function _resolveHLId(league) {
  const season = Number(league.season) || new Date().getFullYear();

  // Auto-discovered league: slug = "hl_<leagueId>" — extract the ID directly
  if (league.slug.startsWith("hl_")) {
    return league.slug.replace("hl_", "");
  }

  // Cricket leagues
  const hlCricket = HL_CRICKET_LEAGUES[league.slug];
  if (hlCricket) {
    // Fall back to currentSeason if the specified season doesn't exist
    return hlCricket.seasons[season] ?? hlCricket.seasons[hlCricket.currentSeason] ?? null;
  }

  // Football leagues
  const hlFootball = HL_FOOTBALL_LEAGUES[league.slug];
  if (hlFootball) {
    return hlFootball.id ?? null;
  }

  // Try to find by slug variation (e.g. 'wc2026' → 'wc')
  const wcSlug = Object.keys(HL_FOOTBALL_LEAGUES).find(s => league.slug.startsWith(s));
  if (wcSlug) return HL_FOOTBALL_LEAGUES[wcSlug].id ?? null;

  return null;
}

function _isFootball(league) {
  return league.sport === "football";
}

// ── Fixtures ──────────────────────────────────────────────────

// In-flight dedup: concurrent requests for the same league share one DB/API call.
const _inflightFixtures = {};

async function getLeagueFixtures(league) {
  const currentYear = new Date().getFullYear();
  const season = Number(league.season) || currentYear;
  const memKey = `league:fixtures:${league.slug}:${season}`;

  // 1. NodeCache
  const mem = getCache(memKey);
  if (mem) return mem;

  // 2. In-flight dedup — concurrent requests share one DB/API call
  if (_inflightFixtures[memKey]) return _inflightFixtures[memKey];

  _inflightFixtures[memKey] = _doGetLeagueFixtures(league, season, memKey, currentYear)
    .finally(() => { delete _inflightFixtures[memKey]; });

  return _inflightFixtures[memKey];
}

async function _doGetLeagueFixtures(league, season, memKey, currentYear) {
  const hlId = _resolveHLId(league);
  if (!hlId) return [];

  // ── Past season: serve directly from warehouse without date-window limits ──
  // For seasons older than the current year, the ±180-day window in
  // getFixturesByWindow would miss them. Use season-scoped queries instead.
  // Past seasons are immutable so we skip the API refresh step.
  if (season < currentYear) {
    const stored = _isFootball(league)
      ? await storage.getFixturesByFootballSeason(hlId, season)
      : await storage.getFixturesBySeason(hlId);

    if (stored.count > 0) {
      const enriched = _isFootball(league) ? stored.fixtures : await storage.enrichFixturesWithLogos(stored.fixtures);
      // Past seasons don't change — cache for 24h
      setCache(memKey, enriched, 24 * 3600);
      return enriched;
    }

    console.warn(`[League:${league.slug}:${season}] No warehouse data for past season`);
    setCache(memKey, [], 6 * 3600);
    return [];
  }

  // ── Current / future season: existing date-window approach ──

  // 2. Warehouse DB — date window (±180 d) so cross-season data is included
  const { fixtures, updatedAt, count } = await storage.getFixturesByWindow(hlId);
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;

  if (count > 0 && ageMs < STALE_MS) {
    const enriched = _isFootball(league) ? fixtures : await storage.enrichFixturesWithLogos(fixtures);
    setCache(memKey, enriched, TTL.FIXTURES);
    return enriched;
  }

  // 3. Highlightly API → refresh warehouse
  console.log(`[League:${league.slug}] fetching from Highlightly API`);
  try {
    const raw = _isFootball(league)
      ? await hl.getFootballMatches({ leagueId: hlId, season })
      : await hl.getMatches({ leagueId: hlId, season, limit: 100 });

    if (raw?.length) {
      const normFn     = _isFootball(league) ? normalizeFootballFixture : normalizeFixture;
      const normalized = raw.map(normFn).filter(Boolean)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      void storage.storeFixtures(normalized);
      void storage.storeTeams(
        normalized.flatMap(f => [f.team1, f.team2]).filter(t => t?.id)
          .map(t => ({ ...t, sport: league.sport || "cricket" }))
      );

      const enriched = _isFootball(league) ? normalized : await storage.enrichFixturesWithLogos(normalized);
      setCache(memKey, enriched, TTL.FIXTURES);
      console.log(`[League:${league.slug}] API → ${normalized.length} fixtures stored`);
      return enriched;
    }
  } catch (e) {
    console.warn(`[League:${league.slug}] API error:`, e.message);
  }

  // 4. Serve stale warehouse data (never empty the app)
  if (count > 0) {
    console.warn(`[League:${league.slug}] serving stale warehouse (${count} fixtures, ${Math.round(ageMs / 3_600_000)}h old)`);
    const enriched = _isFootball(league) ? fixtures : await storage.enrichFixturesWithLogos(fixtures);
    setCache(memKey, enriched, TTL.FIXTURES);
    return enriched;
  }

  // Short TTL so the app recovers quickly once the API quota resets (midnight UTC).
  setCache(memKey, [], 2 * 60);
  return [];
}

// ── Live matches ──────────────────────────────────────────────

async function getLeagueLiveMatches(league) {
  const memKey = `league:live:${league.slug}`;
  const mem    = getCache(memKey);
  if (mem) return mem;

  const hlId = _resolveHLId(league);
  if (!hlId) return [];

  try {
    // Use shared today-cache — all leagues share one API call instead of firing
    // one per league (which was 15 identical requests every 30 s).
    const raw = await _getTodayRaw(_isFootball(league) ? "football" : "cricket");

    const liveRaw = (raw || []).filter(m =>
      String(m.league?.id) === String(hlId) &&
      (m.state?.description === "In play" ||
       m.state?.description === "HT" ||
       (m.status && /live|in play/i.test(m.status)))
    );

    // Enrich with live batting detail
    const normFn = _isFootball(league) ? normalizeFootballFixture : normalizeFixture;
    const live = await Promise.all(
      liveRaw.map(async m => {
        const fixture = normFn(m);
        if (!fixture) return null;
        if (!_isFootball(league)) {
          try {
            const detail = await hl.getMatchDetail(m.id);
            return detail ? normalizeLiveDetail(detail, fixture) : fixture;
          } catch {
            return fixture;
          }
        }
        return fixture;
      })
    );

    const result = live.filter(Boolean).map(m => ({ ...m, status: "live" }));
    setCache(memKey, result, TTL.LIVE);
    return result;
  } catch (e) {
    console.warn(`[League:${league.slug}] live matches error:`, e.message);
    return [];
  }
}

// ── Combined matches (live + upcoming + completed) ────────────

// Detects a finished match whose sync cycle hasn't flipped status to 'completed' yet.
// Patterns: "X won by Y runs/wickets", "tied", "abandoned", "no result".
const RESULT_RE = /\b(won by|tied|abandoned|no result|match drawn)\b/i;
function _isResultText(txt) { return typeof txt === "string" && RESULT_RE.test(txt); }

async function getLeagueMatches(league) {
  const [fixtures, live] = await Promise.all([
    getLeagueFixtures(league),
    getLeagueLiveMatches(league),
  ]);

  // Partition the live list: some "live" matches have already finished but
  // the sync cycle hasn't promoted them to 'completed' yet. Detect this via
  // the statusText and move them to completed immediately.
  const trulyLive = [];
  const justFinished = [];
  for (const m of live) {
    if (_isResultText(m.statusText)) {
      justFinished.push({ ...m, status: "completed" });
    } else {
      trulyLive.push(m);
    }
  }

  const liveIds   = new Set(trulyLive.map(m => m.id));
  const finIds    = new Set(justFinished.map(m => m.id));
  const liveArr   = [...trulyLive];
  const upcoming  = [];
  const completed = [...justFinished];
  const seen      = new Set();
  // Matches whose date is >6h in the past and still "upcoming" in the warehouse
  // are treated as completed — handles seasons that ended without a live sync.
  const pastCutoffMs = Date.now() - 6 * 60 * 60_000;

  for (const m of fixtures) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (liveIds.has(m.id) || finIds.has(m.id)) continue;

    if (m.status === "live") {
      if (_isResultText(m.statusText)) {
        completed.push({ ...m, status: "completed" });
      } else {
        liveArr.push(m);
      }
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

  return { live: liveArr, upcoming, completed };
}

// ── Points table ──────────────────────────────────────────────

async function getLeagueTable(league) {
  const season = Number(league.season) || new Date().getFullYear();
  const memKey = `league:table:${league.slug}:${season}`;

  const mem = getCache(memKey);
  if (mem) return mem;

  const hlId = _resolveHLId(league);
  if (!hlId) {
    console.warn(`[League:${league.slug}] no Highlightly leagueId — cannot fetch standings`);
    return [];
  }

  // Warehouse
  const { standings, updatedAt } = await storage.getStandings(hlId, season);
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;

  if (standings?.length && ageMs < STALE_MS) {
    setCache(memKey, standings, TTL.POINTS_TABLE);
    return standings;
  }

  // API via sync
  const fresh = await sync.syncStandings(hlId, season);
  if (fresh.length) {
    setCache(memKey, fresh, TTL.POINTS_TABLE);
    return fresh;
  }

  // Stale fallback
  if (standings?.length) {
    console.warn(`[League:${league.slug}] serving stale standings`);
    setCache(memKey, standings, TTL.POINTS_TABLE);
    return standings;
  }

  return [];
}

// ── Cache reset ───────────────────────────────────────────────

async function resetLeagueCache(league) {
  delCache(`league:fixtures:${league.slug}`);
  delCache(`league:table:${league.slug}`);
  delCache(`league:live:${league.slug}`);
  // Warehouse data is preserved — only NodeCache entries cleared
  console.log(`[League:${league.slug}] NodeCache cleared (warehouse preserved)`);
}

// ── Teams ─────────────────────────────────────────────────────

async function getLeagueTeams(league) {
  const memKey = `league:teams:${league.slug}`;
  const mem    = getCache(memKey);
  if (mem) return mem;

  const hlId = _resolveHLId(league);
  if (!hlId) return [];

  const teams = await storage.getTeamsByLeague(hlId);
  setCache(memKey, teams, TTL.POINTS_TABLE);
  return teams;
}

// ── Highlights ────────────────────────────────────────────────

async function getLeagueHighlights(league) {
  const memKey = `league:highlights:${league.slug}`;
  const mem    = getCache(memKey);
  if (mem) return mem;

  const hlId = _resolveHLId(league);
  if (!hlId) return [];

  const highlights = await storage.getLeagueHighlights(hlId, 20);
  setCache(memKey, highlights, TTL.HIGHLIGHTS ?? 30 * 60);
  return highlights;
}

module.exports = {
  getLeagueFixtures,
  getLeagueLiveMatches,
  getLeagueMatches,
  getLeagueTable,
  getLeagueTeams,
  getLeagueHighlights,
  resetLeagueCache,
};
