/**
 * leagueService.js — Generic data layer for any Sportsmonks league.
 *
 * Accepts a league config object from leaguesConfig.js and provides
 * the same fixtures / live / matches / table interface that iplService
 * provides for IPL — but for any of the 26 supported leagues.
 *
 * Cache strategy (per-league):
 *   Fixtures  — NodeCache 10 min + DB 6 h
 *   Standings — NodeCache 6 h   + DB 6 h
 *   Live      — NodeCache 30 s  (never DB)
 */

const sm       = require("./sportmonksService");
const db       = require("./dbService");
const supabase = require("../config/supabase");
const { normalizeFixture, normalizeStandings } = require("./sportmonksNormalizer");
const { getCache, setCache, delCache, TTL, KEYS } = require("./cacheService");

// ── Season discovery (for leagues not in hardcoded config) ────

async function resolveSeasonId(league) {
  if (league.seasonId) return Number(league.seasonId);

  const cacheKey = `league:season:${league.leagueId ?? league.slug}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  console.log(`[League:${league.slug}] discovering season for league ${league.leagueId}`);
  const seasons = await sm.getRecentSeasons?.();  // may not exist in older build
  if (!Array.isArray(seasons)) return null;

  const match = seasons.find(s => s.league_id === league.leagueId);
  if (!match) return null;

  setCache(cacheKey, match.id, TTL.DAILY);
  console.log(`[League:${league.slug}] found season ${match.id} (${match.year})`);
  return match.id;
}

// ── Fixtures ──────────────────────────────────────────────────

async function getLeagueFixtures(league) {
  const memKey = `league:fixtures:${league.slug}`;
  const dbKey  = `league:fixtures:${league.slug}:${league.season}`;

  const mem = getCache(memKey);
  if (mem) {
    console.log(`[League:${league.slug}] CACHE HIT — fixtures (memory)`);
    return mem;
  }

  const dbHit = await db.getCachedData(dbKey, 6 * 60 * 60_000);
  if (dbHit) {
    console.log(`[League:${league.slug}] CACHE HIT — fixtures (DB)`);
    setCache(memKey, dbHit, TTL.FIXTURES);
    return dbHit;
  }

  const seasonId = await resolveSeasonId(league);
  if (!seasonId) { console.warn(`[League:${league.slug}] no seasonId`); return []; }

  console.log(`[League:${league.slug}] FETCH — fixtures from Sportsmonks`);
  const raw = await sm.getFixturesBySeasonId(seasonId);
  if (!raw || !Array.isArray(raw)) {
    console.warn(`[League:${league.slug}] no fixtures from API`);
    return [];
  }

  const fixtures = raw
    .map(f => normalizeFixture(f))
    .filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  console.log(`[League:${league.slug}] fixtures: ${fixtures.length} matches`);
  setCache(memKey, fixtures, TTL.FIXTURES);
  // Seed per-fixture fallback cache — match-detail falls back to this when
  // Sportsmonks /fixtures/:id returns null (e.g. new leagues with limited coverage).
  fixtures.forEach(m => {
    if (m.id && !getCache(`match:basic:${m.id}`)) {
      setCache(`match:basic:${m.id}`, m, TTL.FIXTURES);
    }
  });
  void db.setCachedData(dbKey, fixtures);
  void db.syncCricketReferenceData(fixtures);
  return fixtures;
}

// ── Live matches ──────────────────────────────────────────────
// Filters the global /livescores feed by this league's season_id.

async function getLeagueLiveMatches(league) {
  const memKey = `league:live:${league.slug}`;
  const mem = getCache(memKey);
  if (mem) return mem;

  const seasonId = await resolveSeasonId(league);
  const raw = await sm.getLivescores();
  if (!Array.isArray(raw)) return [];

  // 12 h is the absolute ceiling for any cricket format (inc. rain-delayed ODIs).
  // If Sportsmonks' livescores feed keeps returning a match beyond this window
  // it means their feed is stale — don't propagate the error to the app.
  const MAX_LIVE_MS = 12 * 60 * 60 * 1000;

  const live = raw
    .filter(f => {
      if (!seasonId || f.season_id !== seasonId) return false;
      if (f.starting_at) {
        const age = Date.now() - new Date(f.starting_at).getTime();
        if (age > MAX_LIVE_MS) {
          console.warn(`[League] dropping stale livescores entry for fixture ${f.id} (started ${Math.round(age / 3600000)}h ago)`);
          return false;
        }
      }
      return true;
    })
    .map(f => normalizeFixture(f))
    .filter(Boolean)
    .map(m => ({
      ...m,
      status: "live",
      // normalizeFixture sets statusText to "Match starts at <time>" only when
      // it computed status as "upcoming" — but this fixture is from Sportsmonks'
      // own /livescores feed, so it's actually in progress and that raw status
      // was simply lagging. Don't let the now-false "Match starts at" text
      // leak through once we know better; let the UI's own live fallback show.
      statusText: /^Match starts at/.test(m.statusText) ? "" : m.statusText,
    }));

  setCache(memKey, live, TTL.LIVE);
  return live;
}

// ── Matches (live + upcoming + completed) ─────────────────────

async function getLeagueMatches(league) {
  const [fixtures, live] = await Promise.all([
    getLeagueFixtures(league),
    getLeagueLiveMatches(league),
  ]);

  const liveIds           = new Set(live.map(m => m.id));
  const liveList          = [...live];
  const upcoming          = [];
  const seen              = new Set();
  const STARTED_BUFFER_MS = 4 * 60 * 60 * 1000; // 4 hours

  // ── Pass 1: categorise fixtures ──────────────────────────────
  // Collect completed fixtures first so we can bulk-fetch their results
  // from Supabase in ONE query instead of N individual queries.

  const completedFixtures = []; // { match, startedInPast }

  for (const m of fixtures) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (liveIds.has(m.id)) continue;

    const startedInPast   = m.date && (Date.now() - new Date(m.date).getTime()) > STARTED_BUFFER_MS;
    const hasStoredResult = !!getCache(`completed_match:${m.id}`);
    const effectiveStatus =
      (hasStoredResult || (startedInPast && m.status !== "completed"))
        ? "completed"
        : m.status;

    if (effectiveStatus === "live") {
      liveList.push(m);
    } else if (effectiveStatus === "completed") {
      completedFixtures.push({ match: m, startedInPast });
    } else {
      upcoming.push(m);
    }
  }

  // ── Pass 2: bulk-load missing results (1 query, not N) ───────
  // Only fetch for matches not already in NodeCache.

  const needResults = completedFixtures.filter(({ match: m }) => !getCache(`completed_match:${m.id}`));

  if (needResults.length > 0) {
    try {
      const ids = needResults.map(({ match: m }) => String(m.id));
      const { data: rows } = await supabase
        .from("match_results")
        .select("match_id, data")
        .in("match_id", ids);

      const resultsMap = new Map((rows ?? []).map(r => [r.match_id, r.data]));

      for (const { match: m } of needResults) {
        const result = resultsMap.get(String(m.id));
        if (result) {
          setCache(`completed_match:${m.id}`, { ...result, status: "completed", isCompleted: true }, 24 * 60 * 60);
          console.log(`[League] match ${m.id} result loaded from Supabase (bulk)`);
        }
      }

      // Background: for matches still missing, try Sportsmonks (fire-and-forget)
      for (const { match: m, startedInPast } of needResults) {
        if (resultsMap.has(String(m.id))) continue;
        if (!startedInPast || m.score1) continue;
        const lockKey = `loading_result:${m.id}`;
        if (getCache(lockKey)) continue;
        setCache(lockKey, true, 300); // 5 min lock to avoid hammering Sportsmonks
        sm.getFixtureDetail(m.id).then(detail => {
          if (!detail) return;
          const updated = normalizeFixture(detail);
          if (updated?.score1) {
            setCache(`completed_match:${m.id}`, { ...updated, status: "completed", isCompleted: true }, 24 * 60 * 60);
            delCache(KEYS.LEAGUE_FIXTURES(league.slug));
          }
        }).catch(() => {});
      }
    } catch (e) {
      console.warn(`[League:${league.slug}] bulk match_results fetch failed:`, e.message);
    }
  }

  // ── Pass 3: build completed list with fresh NodeCache ────────
  const completed = completedFixtures.map(({ match: m }) => {
    const cached = getCache(`completed_match:${m.id}`);
    return cached ?? { ...m, status: "completed", isCompleted: true };
  });

  upcoming.sort((a, b)  => new Date(a.date) - new Date(b.date));
  completed.sort((a, b) => new Date(b.date) - new Date(a.date));

  console.log(`[League:${league.slug}] matches — live=${liveList.length} upcoming=${upcoming.length} completed=${completed.length}`);
  return { live: liveList, upcoming, completed };
}

// ── Stage discovery (for leagues not in hardcoded config) ─────

async function resolveStageId(league) {
  if (league.stageId) return { stageId: league.stageId, playoffId: league.playoffId };

  const stageKey = `league:stages:${league.slug}`;
  const cached   = getCache(stageKey);
  if (cached) return cached;

  console.log(`[League:${league.slug}] discovering stages for season ${league.seasonId}`);
  const stages = await sm.getSeasonStages(league.seasonId);
  if (!Array.isArray(stages) || stages.length === 0) return { stageId: null, playoffId: null };

  // Pick the first group/regular stage and first knockout stage
  const regular  = stages.find(s => /group|regular|league/i.test(s.name ?? "")) ?? stages[0];
  const knockout = stages.find(s => /knock|play.?off|final|elim/i.test(s.name ?? "") && s.id !== regular?.id) ?? null;

  const result = { stageId: regular?.id ?? null, playoffId: knockout?.id ?? null };
  setCache(stageKey, result, TTL.DAILY);
  console.log(`[League:${league.slug}] stages: regular=${result.stageId} playoff=${result.playoffId}`);
  return result;
}

// ── Points table ──────────────────────────────────────────────

async function getLeagueTable(league) {
  const memKey = `league:table:${league.slug}`;
  const dbKey  = `league:table:${league.slug}:${league.season}`;

  const mem = getCache(memKey);
  if (mem) {
    console.log(`[League:${league.slug}] CACHE HIT — table (memory)`);
    return mem;
  }

  const dbHit = await db.getCachedData(dbKey, 6 * 60 * 60_000);
  if (dbHit) {
    console.log(`[League:${league.slug}] CACHE HIT — table (DB)`);
    setCache(memKey, dbHit, TTL.POINTS_TABLE);
    return dbHit;
  }

  // Discover stage IDs if not in config
  const { stageId, playoffId } = await resolveStageId(league);
  if (!stageId) {
    console.warn(`[League:${league.slug}] no stageId — cannot fetch standings`);
    return [];
  }

  console.log(`[League:${league.slug}] FETCH — standings from Sportsmonks`);
  const { regular } = await sm.getStandingsByStageIds(stageId, playoffId);
  const table = normalizeStandings(regular);

  if (table.length > 0) {
    setCache(memKey, table, TTL.POINTS_TABLE);
    void db.setCachedData(dbKey, table);
    console.log(`[League:${league.slug}] table: ${table.length} teams`);
  }
  return table;
}

// ── Cache reset ───────────────────────────────────────────────

async function resetLeagueCache(league) {
  const memKeys = [
    `league:fixtures:${league.slug}`,
    `league:table:${league.slug}`,
    `league:live:${league.slug}`,
  ];
  const { delCache } = require("./cacheService");
  for (const k of memKeys) delCache(k);

  await Promise.all([
    db.deleteFixtures(`league:fixtures:${league.slug}:${league.season}`),
    db.deleteFixtures(`league:table:${league.slug}:${league.season}`),
  ]);
  console.log(`[League:${league.slug}] cache reset`);
}

module.exports = {
  getLeagueFixtures,
  getLeagueLiveMatches,
  getLeagueMatches,
  getLeagueTable,
  resetLeagueCache,
};
