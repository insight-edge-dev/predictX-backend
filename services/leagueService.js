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
  void db.setCachedData(dbKey, fixtures);
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

  const live = raw
    .filter(f => seasonId && f.season_id === seasonId)
    .map(f => normalizeFixture(f))
    .filter(Boolean)
    .map(m => ({ ...m, status: "live" }));

  setCache(memKey, live, TTL.LIVE);
  return live;
}

// ── Matches (live + upcoming + completed) ─────────────────────

async function getLeagueMatches(league) {
  const [fixtures, live] = await Promise.all([
    getLeagueFixtures(league),
    getLeagueLiveMatches(league),
  ]);

  const liveIds    = new Set(live.map(m => m.id));
  const liveList   = [...live];
  const upcoming   = [];
  const completed  = [];
  const seen       = new Set();

  // Only force-complete a fixture if it started 4+ hours ago AND it isn't live.
  // 30 min was too aggressive — delayed/rain-affected matches got incorrectly completed.
  // Matches saved in match_results (via WS) are handled separately with full data.
  const STARTED_BUFFER_MS = 4 * 60 * 60 * 1000; // 4 hours

  for (const m of fixtures) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (liveIds.has(m.id)) continue;

    const startedInPast  = m.date && (Date.now() - new Date(m.date).getTime()) > STARTED_BUFFER_MS;
    const hasStoredResult = !!getCache(`completed_match:${m.id}`);
    // Force completed if: WS already saved a result (NodeCache hit) OR 4h past start time
    const effectiveStatus =
      (hasStoredResult || (startedInPast && m.status !== "completed"))
        ? "completed"
        : m.status;

    if (effectiveStatus === "live") {
      liveList.push(m);
    } else if (effectiveStatus === "completed") {
      // Priority: 1) NodeCache  2) Supabase match_results  3) raw fixture (may have no scores)
      const memCached = getCache(`completed_match:${m.id}`);
      if (memCached) {
        completed.push({ ...memCached, status: "completed", isCompleted: true });
      } else {
        // Push stale fixture immediately so the UI shows something
        completed.push({ ...m, status: "completed", isCompleted: true });

        // Background: load from Supabase then re-warm NodeCache
        const lockKey = `loading_result:${m.id}`;
        if (!getCache(lockKey)) {
          setCache(lockKey, true, 30);
          supabase.from("match_results")
            .select("data")
            .eq("match_id", String(m.id))
            .single()
            .then(({ data: row }) => {
              if (row?.data) {
                setCache(`completed_match:${m.id}`, { ...row.data, status: "completed", isCompleted: true }, 24 * 60 * 60);
                delCache(KEYS.LEAGUE_FIXTURES(league.slug));
                console.log(`[League] match ${m.id} result loaded from Supabase`);
              } else if (startedInPast && !m.score1) {
                // Not in Supabase yet — try Sportsmonks fixture detail
                sm.getFixtureDetail(m.id).then(detail => {
                  if (!detail) return;
                  const updated = normalizeFixture(detail);
                  if (updated?.score1) {
                    setCache(`completed_match:${m.id}`, { ...updated, status: "completed", isCompleted: true }, 24 * 60 * 60);
                    delCache(KEYS.LEAGUE_FIXTURES(league.slug));
                  }
                }).catch(() => {});
              }
            })
            .catch(() => {});
        }
      }
    } else {
      upcoming.push(m);
    }
  }

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
