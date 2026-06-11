/**
 * internationalService.js — bilateral international cricket series.
 *
 * Sportsmonks doesn't model bilateral tours (e.g. "New Zealand tour of India")
 * as standalone leagues — they're all dumped into one generic worldwide bucket
 * per format ("Twenty20 International", league id 3). A single season of that
 * bucket mixes 30+ unrelated tours happening simultaneously around the globe,
 * with no shared points table.
 *
 * The fix: every fixture in these buckets carries a `stage` relation whose
 * `name` IS the series name (e.g. "New Zealand tour of India", "Pakistan tour
 * of Sri Lanka", "Viking Cup" for multi-team events). Grouping fixtures by
 * `stage.id` produces clean, ready-made, properly-named series — no heuristic
 * team-pair/date grouping required.
 */

const sm = require("./sportmonksService");
const { normalizeFixture } = require("./sportmonksNormalizer");
const { getCache, setCache, TTL, KEYS } = require("./cacheService");

// Generic international buckets to surface. Men's T20I (id 3) is the only
// major men's bilateral bucket in the current Sportsmonks plan. Women's T20I
// (id 258) and women's ODI (id 261) follow the exact same shape — fixtures
// carry a `stage` relation grouping them into named tours/series.
const INTERNATIONAL_LEAGUES = {
  t20i: {
    slug:     "t20i",
    leagueId: 3,
    name:     "Twenty20 International",
    short:    "T20I",
    format:   "T20",
    flag:     "🌍",
  },
  wt20i: {
    slug:     "wt20i",
    leagueId: 258,
    name:     "Twenty20 International Women",
    short:    "WT20I",
    format:   "T20",
    flag:     "🌍",
  },
  wodi: {
    slug:     "wodi",
    leagueId: 261,
    name:     "One Day International Women",
    short:    "WODI",
    format:   "ODI",
    flag:     "🌍",
  },
};

const STARTED_BUFFER_MS = 4 * 60 * 60 * 1000; // 4 hours — mirrors leagueService heuristic

function effectiveStatus(m) {
  if (m.status === "live") return "live";
  const startedInPast = m.date && (Date.now() - new Date(m.date).getTime()) > STARTED_BUFFER_MS;
  if (m.status === "completed" || startedInPast) return "completed";
  return "upcoming";
}

// Bulk fixture fetches don't include `batting`/`bowling`/fresh `runs`, so a
// live match's score/overs/current-batsmen are stale or empty. Re-fetch that
// one fixture's full detail (cheap — only live matches, typically 0-3 per
// series) and merge in whatever fresher fields Sportsmonks now has.
async function enrichLiveMatch(m) {
  try {
    const raw = await sm.getFixtureDetail(m.id);
    const fresh = raw && normalizeFixture(raw);
    if (!fresh) return m;
    return {
      ...m,
      score1:     fresh.score1 ?? m.score1,
      score2:     fresh.score2 ?? m.score2,
      overs1:     fresh.overs1 ?? m.overs1,
      overs2:     fresh.overs2 ?? m.overs2,
      statusText: fresh.statusText || m.statusText,
      batsmen:    fresh.batsmen.length ? fresh.batsmen : m.batsmen,
      bowlers:    fresh.bowlers.length ? fresh.bowlers : m.bowlers,
      toss:       fresh.toss ?? m.toss,
      winner:     fresh.winner ?? m.winner,
      status:     fresh.status,
    };
  } catch (e) {
    console.warn(`[Intl] enrichLiveMatch(${m.id}) failed:`, e.message);
    return m;
  }
}

function uniqueTeams(matches) {
  const map = new Map();
  for (const m of matches) {
    if (m.team1?.id) map.set(m.team1.id, m.team1);
    if (m.team2?.id) map.set(m.team2.id, m.team2);
  }
  return [...map.values()];
}

// ── Fetch + normalize + cache one bucket's current-season fixtures ────

async function getBucketFixtures(bucket) {
  const memKey = KEYS.INTL_SERIES_LIST(bucket.slug);
  const cached = getCache(memKey);
  if (cached) return cached;

  const season = await sm.getSeasonForLeague(bucket.leagueId);
  if (!season?.id) {
    console.warn(`[Intl:${bucket.slug}] no current season found`);
    return [];
  }

  console.log(`[Intl:${bucket.slug}] FETCH — fixtures for season ${season.id} (${season.name})`);
  const raw = await sm.getInternationalFixtures(season.id);
  const fixtures = (raw || [])
    .map(normalizeFixture)
    .filter(Boolean)
    .filter(m => m.stageId != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  console.log(`[Intl:${bucket.slug}] fixtures: ${fixtures.length} across ${new Set(fixtures.map(f => f.stageId)).size} series`);
  setCache(memKey, fixtures, TTL.INTL_SERIES);
  return fixtures;
}

function buildSeriesSummary(stageId, matches, bucket) {
  const statuses       = matches.map(effectiveStatus);
  const completedCount = statuses.filter(s => s === "completed").length;
  const liveCount      = statuses.filter(s => s === "live").length;
  const status =
    liveCount > 0                       ? "live"
    : completedCount === matches.length ? "completed"
    : "upcoming";

  return {
    id:         String(stageId),
    name:       matches[0].stageName || "International Series",
    format:     bucket.format,
    leagueSlug: bucket.slug,
    teams:      uniqueTeams(matches),
    matchCount: matches.length,
    completedCount,
    status,
    startDate:  matches[0].date,
    endDate:    matches[matches.length - 1].date,
  };
}

// ── Public API ─────────────────────────────────────────────────

async function getSeriesList() {
  const all = [];

  for (const bucket of Object.values(INTERNATIONAL_LEAGUES)) {
    const fixtures = await getBucketFixtures(bucket);
    const groups = new Map();
    for (const m of fixtures) {
      if (!groups.has(m.stageId)) groups.set(m.stageId, []);
      groups.get(m.stageId).push(m);
    }
    for (const [stageId, matches] of groups) {
      all.push(buildSeriesSummary(stageId, matches, bucket));
    }
  }

  // Surface what users care about most: live now, then soonest upcoming,
  // then most-recently-completed.
  const rank = { live: 0, upcoming: 1, completed: 2 };
  all.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    const ad = new Date(a.startDate).getTime();
    const bd = new Date(b.startDate).getTime();
    return a.status === "completed" ? bd - ad : ad - bd;
  });

  return all;
}

async function getSeriesDetail(stageId) {
  for (const bucket of Object.values(INTERNATIONAL_LEAGUES)) {
    const fixtures = await getBucketFixtures(bucket);
    const matches  = fixtures.filter(m => String(m.stageId) === String(stageId));
    if (matches.length === 0) continue;

    const liveRaw = [], upcoming = [], completed = [];
    for (const m of matches) {
      const st = effectiveStatus(m);
      if (st === "live")           liveRaw.push(m);
      else if (st === "completed") completed.push({ ...m, status: "completed", isCompleted: true });
      else                         upcoming.push(m);
    }

    // Refresh live matches with per-fixture detail; some may have finished
    // since the bulk fetch — re-bucket those into completed.
    const live = [];
    for (const m of await Promise.all(liveRaw.map(enrichLiveMatch))) {
      if (m.status === "live") live.push({ ...m, status: "live" });
      else completed.push({ ...m, status: "completed", isCompleted: true });
    }

    upcoming.sort((a, b)  => new Date(a.date) - new Date(b.date));
    completed.sort((a, b) => new Date(b.date) - new Date(a.date));

    return {
      series: {
        id:         String(stageId),
        name:       matches[0].stageName || "International Series",
        format:     bucket.format,
        leagueSlug: bucket.slug,
        teams:      uniqueTeams(matches),
        matchCount: matches.length,
      },
      matches: { live, upcoming, completed },
    };
  }
  return null;
}

// Look up a single normalized match by id across all international buckets —
// used by the tips controller to build a full prediction without needing the
// caller to know which bucket/series the match belongs to.
async function findMatch(matchId) {
  for (const bucket of Object.values(INTERNATIONAL_LEAGUES)) {
    const fixtures = await getBucketFixtures(bucket);
    const match = fixtures.find(m => String(m.id) === String(matchId));
    if (match) return { match, fixtures, leagueId: bucket.leagueId };
  }
  return null;
}

module.exports = {
  INTERNATIONAL_LEAGUES,
  getBucketFixtures,
  getSeriesList,
  getSeriesDetail,
  findMatch,
};
