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
 *
 * Buckets are auto-discovered daily from the Sportsmonks /leagues endpoint —
 * any new international format added to our subscription (Men's ODI, Test,
 * Women's Test, etc.) is picked up automatically, zero code change needed.
 */

const sm = require("./sportmonksService");
const { normalizeFixture } = require("./sportmonksNormalizer");
const { getCache, setCache, TTL, KEYS } = require("./cacheService");
const { LEAGUES } = require("../config/leaguesConfig");

// ── Bucket auto-discovery ─────────────────────────────────────────────────────
//
// "Bilateral buckets" are Sportsmonks leagues that:
//   (a) belong to no specific country (country_id === 0 / null → "World")
//   (b) are NOT already managed as standalone tournaments in leaguesConfig.js
//
// Fallback covers the 3 confirmed billing-plan buckets (used when the API
// is unreachable or returns an empty list during a fresh boot).

const KNOWN_BUCKETS = {
  t20i:  { slug: "t20i",  leagueId: 3,   name: "Twenty20 International",       short: "T20I",  format: "T20", flag: "🌍" },
  wt20i: { slug: "wt20i", leagueId: 258, name: "Twenty20 International Women", short: "WT20I", format: "T20", flag: "🌍" },
  wodi:  { slug: "wodi",  leagueId: 261, name: "One Day International Women",  short: "WODI",  format: "ODI", flag: "🌍" },
};

// Sportsmonks league IDs already in leaguesConfig — exclude from discovery
// so tournaments (T20 WC, ICC CWC, etc.) aren't double-counted.
const MANAGED_LEAGUE_IDS = new Set(Object.values(LEAGUES).map(l => l.leagueId));

const BUCKET_DISCOVERY_KEY = "intl:buckets:discovered";

function _deriveFormat(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("test")) return "Test";
  if (n.includes("one day") || n.includes(" odi")) return "ODI";
  return "T20";
}

function _deriveShort(name) {
  const n   = (name || "").toLowerCase();
  const fem = n.includes("women") ? "W" : "";
  if (n.includes("test"))                          return `${fem}Test`;
  if (n.includes("one day") || n.includes(" odi")) return `${fem}ODI`;
  return `${fem}T20I`;
}

function _slugify(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Patterns that must appear in a league name for it to be considered a
// generic bilateral-format bucket (not a named domestic tournament).
const BILATERAL_KEYWORDS = ["international", "one day", "test match"];

async function _discoverBuckets() {
  const cached = getCache(BUCKET_DISCOVERY_KEY);
  if (cached) return cached;

  try {
    const leagues = await sm.getAllLeagues();
    if (!leagues?.length) throw new Error("empty response");

    const discovered = [];
    for (const l of leagues) {
      const isWorldwide    = !l.country_id || l.country_id === 0;
      const notManaged     = !MANAGED_LEAGUE_IDS.has(l.id);
      const nameLower      = (l.name || "").toLowerCase();
      const isBilateralFmt = BILATERAL_KEYWORDS.some(kw => nameLower.includes(kw));

      if (!isWorldwide || !notManaged || !isBilateralFmt) continue;

      // Known buckets keep their canonical slug/short for cache-key stability.
      const known = Object.values(KNOWN_BUCKETS).find(b => b.leagueId === l.id);
      discovered.push(known ?? {
        slug:     _slugify(l.code || l.name),
        leagueId: l.id,
        name:     l.name,
        short:    _deriveShort(l.name),
        format:   _deriveFormat(l.name),
        flag:     "🌍",
      });
    }

    if (discovered.length === 0) throw new Error("no matching leagues");

    console.log(`[Intl] discovered ${discovered.length} bilateral bucket(s): ${discovered.map(b => b.short).join(", ")}`);
    setCache(BUCKET_DISCOVERY_KEY, discovered, TTL.DAILY);
    return discovered;
  } catch (e) {
    console.warn(`[Intl] bucket discovery failed (${e.message}) — using known fallback`);
    const fallback = Object.values(KNOWN_BUCKETS);
    setCache(BUCKET_DISCOVERY_KEY, fallback, 30 * 60); // retry in 30 min
    return fallback;
  }
}

// Exported so resolverService and controller can reuse the same cached list.
async function getActiveBuckets() {
  return _discoverBuckets();
}

// Sync lookup used by internationalController.leagueIdFor — checks known
// buckets first (fast path), then falls back to the discovered cache.
async function getLeagueIdForSlug(slug) {
  if (KNOWN_BUCKETS[slug]) return KNOWN_BUCKETS[slug].leagueId;
  const buckets = await _discoverBuckets();
  return buckets.find(b => b.slug === slug)?.leagueId ?? null;
}

// Keep the named export for backward compat (resolverService iterates it).
// Points to KNOWN_BUCKETS but callers should prefer getActiveBuckets().
const INTERNATIONAL_LEAGUES = KNOWN_BUCKETS;

const STARTED_BUFFER_MS  = 4 * 60 * 60 * 1000; // 4 hours — mirrors leagueService heuristic
const LIVE_MAX_DURATION_MS = 8 * 60 * 60 * 1000; // a T20/ODI can't still be live after 8 h

// Max overs per format — used to detect a match that's over even when the
// Sportsmonks bulk-fixture cache still returns status "live" (up to 6h stale).
const FORMAT_MAX_OVERS = { t20: 20, t20i: 20, odi: 50, odii: 50 };

function isDefinitelyOver(m) {
  const maxOvers = FORMAT_MAX_OVERS[(m.matchType || "").toLowerCase()];
  if (!maxOvers || !m.overs1 || !m.overs2) return false;
  // overs can be "19.3" (fractional) — parseFloat handles both
  return parseFloat(m.overs1) >= maxOvers - 1 && parseFloat(m.overs2) > 0;
}

function effectiveStatus(m) {
  if (m.status === "live") {
    const ageMs = m.date ? Date.now() - new Date(m.date).getTime() : 0;
    if (ageMs >= LIVE_MAX_DURATION_MS) return "completed";
    // Both innings complete → match is over regardless of stale cache status
    if (isDefinitelyOver(m)) return "completed";
    // T20 formats can't run longer than 4h; use tighter window than the ODI ceiling
    const formatKey = (m.matchType || "").toLowerCase();
    const maxMs = formatKey.startsWith("t20") ? 4 * 60 * 60 * 1000 : LIVE_MAX_DURATION_MS;
    if (ageMs >= maxMs) return "completed";
    return "live";
  }
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
      // Never let a stale pre-match "Match starts at" string leak through for
      // a fixture we already know is live — same desync class as
      // leagueService.getLeagueLiveMatches (normalizeFixture only writes
      // that text when its raw status read "upcoming", which can lag).
      statusText: fresh.statusText || (/^Match starts at/.test(m.statusText) ? "" : m.statusText),
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

  // Try the two most-recent seasons. Sportsmonks sometimes creates a new season
  // container (higher ID) before populating it — if the newest season returns 0
  // stage-tagged fixtures we fall back to the previous season which still holds
  // the current bilateral series data.
  const seasons = await sm.getSeasonsForLeague(bucket.leagueId, 2);
  for (const season of seasons) {
    if (!season?.id) continue;

    console.log(`[Intl:${bucket.slug}] FETCH — fixtures for season ${season.id} (${season.name})`);
    const raw = await sm.getInternationalFixtures(season.id);
    const fixtures = (raw || [])
      .map(normalizeFixture)
      .filter(Boolean)
      .filter(m => m.stageId != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`[Intl:${bucket.slug}] season ${season.id}: ${fixtures.length} fixtures across ${new Set(fixtures.map(f => f.stageId)).size} series`);

    // Only cache and return if we got real data — never cache empty results,
    // which are likely a transient rate-limit or API error rather than a
    // genuinely empty season.
    if (fixtures.length > 0) {
      setCache(memKey, fixtures, TTL.INTL_SERIES);
      return fixtures;
    }
  }

  console.warn(`[Intl:${bucket.slug}] no fixtures found in any recent season`);
  return [];
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
  const buckets = await getActiveBuckets();
  const allFixtures = await Promise.all(buckets.map(b => getBucketFixtures(b)));

  const all = [];
  buckets.forEach((bucket, i) => {
    const fixtures = allFixtures[i];
    const groups = new Map();
    for (const m of fixtures) {
      if (!groups.has(m.stageId)) groups.set(m.stageId, []);
      groups.get(m.stageId).push(m);
    }
    for (const [stageId, matches] of groups) {
      all.push(buildSeriesSummary(stageId, matches, bucket));
    }
  });

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
  for (const bucket of await getActiveBuckets()) {
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

// Returns live + today + upcoming (30-day window) + recently completed (14-day)
// international fixtures across all 3 buckets, for the Matches and Discovery screens.
async function getScheduleFixtures(daysAhead = 30) {
  const now      = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const cutoffMs = now + daysAhead * 86_400_000;
  const cutoffStr  = new Date(cutoffMs).toISOString().slice(0, 10);
  const lookbackMs = 14 * 86_400_000;
  const lookbackStr = new Date(now - lookbackMs).toISOString().slice(0, 10);

  const live = [], today = [], upcoming = [], completed = [];
  const buckets = await getActiveBuckets();
  // Parallel — same data as getSeriesList hits, usually already in NodeCache
  const allFixtures = await Promise.all(buckets.map(b => getBucketFixtures(b)));

  for (let bi = 0; bi < buckets.length; bi++) {
    const bucket   = buckets[bi];
    const fixtures = allFixtures[bi];
    for (const m of fixtures) {
      if (!m.date) continue;
      const st      = effectiveStatus(m);
      const dateStr = m.date.slice(0, 10);
      const entry   = { ...m, leagueLabel: bucket.short };

      if (st === "live") {
        live.push(entry);
      } else if (st === "completed") {
        // Include recently completed matches (last 14 days)
        if (dateStr >= lookbackStr && dateStr <= todayStr) {
          completed.push(entry);
        }
      } else {
        if (dateStr === todayStr) {
          today.push(entry);
        } else if (dateStr > todayStr && dateStr <= cutoffStr) {
          upcoming.push(entry);
        }
      }
    }
  }

  today.sort((a, b)     => new Date(a.date) - new Date(b.date));
  upcoming.sort((a, b)  => new Date(a.date) - new Date(b.date));
  completed.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { live, today, upcoming, completed };
}

// Look up a single normalized match by id across all international buckets —
// used by the tips controller to build a full prediction without needing the
// caller to know which bucket/series the match belongs to.
async function findMatch(matchId) {
  for (const bucket of await getActiveBuckets()) {
    const fixtures = await getBucketFixtures(bucket);
    const match = fixtures.find(m => String(m.id) === String(matchId));
    if (match) return { match, fixtures, leagueId: bucket.leagueId };
  }
  return null;
}

module.exports = {
  INTERNATIONAL_LEAGUES,   // backward-compat alias → KNOWN_BUCKETS
  getActiveBuckets,        // preferred: dynamic discovery + fallback
  getLeagueIdForSlug,      // async slug→leagueId lookup
  getBucketFixtures,
  getSeriesList,
  getSeriesDetail,
  getScheduleFixtures,
  findMatch,
  effectiveStatus,
};
