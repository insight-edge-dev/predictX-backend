const iplService     = require("../services/iplService");
const leagueService  = require("../services/leagueService");
const tipsService    = require("../services/tipsService");
const genericTips    = require("../services/genericTipsService");
const { getPersistentLightTip } = require("../services/lightTipService");
const db             = require("../services/dbService");
const { getCache, setCache, TTL } = require("../services/cacheService");
const { getLeague, LEAGUES }  = require("../config/leaguesConfig");

// Predictions are static (pre-match historical data) — never expire in DB.
const PRED_TTL_DB  = 365 * 24 * 60 * 60_000; // 1 year
const PRED_TTL_MEM = TTL.DAILY;               // 24 h in memory

// Run async tasks with at most `limit` in flight at once.
async function withConcurrency(items, fn, limit = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const chunk = await Promise.all(batch.map(fn));
    results.push(...chunk);
  }
  return results;
}

// ── Prediction bulk-prime ─────────────────────────────────────
// On the first tips request each server lifecycle, pull ALL stored
// predictions from Supabase in ONE query and load them into NodeCache.
// Every subsequent match lookup is a pure in-memory hit — no DB at all.
// This is the key fix: N individual DB queries → 1 bulk query per lifecycle.

let _predsCachePrimed = false;
const _predsPrimeInFlight = { promise: null };

async function primePredictionsCache() {
  if (_predsCachePrimed) return;

  // Single-flight: if priming is already in progress, wait for it.
  if (_predsPrimeInFlight.promise) {
    return _predsPrimeInFlight.promise;
  }

  _predsPrimeInFlight.promise = (async () => {
    try {
      const dbMap = await db.getCachedDataByPrefix("pred:light:");
      let primed = 0;
      for (const [key, data] of dbMap) {
        const matchId = key.replace("pred:light:", "");
        const memKey  = `tips:light:${matchId}`;
        if (!getCache(memKey)) {
          setCache(memKey, data, PRED_TTL_MEM);
          primed++;
        }
      }
      _predsCachePrimed = true;
      console.log(`[Tips] primed ${primed}/${dbMap.size} prediction(s) into memory (1 DB query)`);
    } catch (e) {
      // Allow retry on next request
      console.warn("[Tips] prediction prime failed:", e.message);
    } finally {
      _predsPrimeInFlight.promise = null;
    }
  })();

  return _predsPrimeInFlight.promise;
}

// ── Single-flight map ─────────────────────────────────────────
// If 100 users hit a cold tips cache simultaneously, only 1 computation
// runs per league. The other 99 await that same Promise instead of each
// starting their own (which would multiply the Supabase load by 100×).

const _inFlightLeagues = new Map();

// ── League resolution ─────────────────────────────────────────
// `league` query param selects the league; defaults to IPL so existing
// callers (no param) keep working exactly as before.

function resolveLeagueSlug(req) {
  const slug = (req.query.league || "ipl").toString();
  return slug === "ipl" ? "ipl" : slug;
}

// ── Persistent lightweight tip ────────────────────────────────
// Check memory → DB → generate.  Writes to DB on first generation
// so the prediction survives server restarts forever.
// ── Core per-league computation ───────────────────────────────
// Returns { matches: MatchWithTip[] } from cache or by generating predictions.
//
// Scaling strategy:
//   1. NodeCache hit → return instantly (no DB)
//   2. Single-flight → 100 concurrent cold requests = 1 actual computation
//   3. Bulk prime → loads ALL existing predictions in 1 DB query before processing
//   4. Only truly-new matches (no DB record yet) generate predictions (rare)

async function _doComputeLeague(slug) {
  const isIPL    = slug === "ipl";
  const cacheKey = isIPL ? "tips:list" : `tips:list:${slug}`;

  // Re-check after acquiring single-flight (another request may have warmed it)
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // Bulk-load ALL known predictions into NodeCache with ONE Supabase query.
  // After this, every match lookup below is a pure memory hit.
  await primePredictionsCache();

  let matches, ctx;
  if (isIPL) {
    matches = await iplService.getIPLMatches();
    ctx = { isIPL: true };
  } else {
    const league = getLeague(slug);
    if (!league || league.sport !== "cricket") {
      const empty = { matches: [] };
      setCache(cacheKey, empty, 30 * 60);
      return empty;
    }
    const [leagueMatches, table] = await Promise.all([
      leagueService.getLeagueMatches(league),
      leagueService.getLeagueTable(league),
    ]);
    matches = leagueMatches;
    ctx = { isIPL: false, table, completed: matches.completed, slug };
  }

  const tippable = [...matches.live, ...matches.upcoming, ...matches.completed];

  // After the bulk prime, most matches hit NodeCache immediately.
  // Only truly new matches (no stored prediction yet) hit the DB/generator.
  // Concurrency limit of 3 on generation guards the connection pool for those.
  const withTips = await withConcurrency(tippable, async (m) => {
    try {
      const tip = await getPersistentLightTip(m, ctx);
      return { ...m, tip: tip ?? null };
    } catch {
      return { ...m, tip: null };
    }
  }, 3);

  const payload = { matches: withTips };
  setCache(cacheKey, payload, 30 * 60);
  return payload;
}

async function computeTipsForLeague(slug) {
  const cacheKey = slug === "ipl" ? "tips:list" : `tips:list:${slug}`;

  // Fast path: NodeCache hit — no async work at all
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // Single-flight: if already computing, return the same Promise
  if (_inFlightLeagues.has(slug)) return _inFlightLeagues.get(slug);

  const promise = _doComputeLeague(slug).finally(() => _inFlightLeagues.delete(slug));
  _inFlightLeagues.set(slug, promise);
  return promise;
}

// ── GET /api/tips?league=<slug> ───────────────────────────────
// Returns live + upcoming + completed matches with predictions.
// `league` defaults to IPL (unchanged behaviour for existing callers).

async function getTipsList(req, res) {
  const slug = resolveLeagueSlug(req);
  try {
    const payload = await computeTipsForLeague(slug);
    return res.json(payload);
  } catch (e) {
    console.error("[Tips] getTipsList error:", e.message);
    return res.status(500).json({ matches: [] });
  }
}

// ── GET /api/tips/bundle ──────────────────────────────────────
// Returns tips for all active (2026-season) cricket leagues in one request.
// Leagues are processed 2-at-a-time (each league already limits to 5 concurrent
// DB queries) so cold-start peak load stays within the free-tier connection pool.
// Warm requests (NodeCache hits) run instantly regardless of concurrency.

async function getTipsBundle(_req, res) {
  try {
    const slugs = Object.values(LEAGUES)
      .filter(l => l.sport === "cricket")
      .map(l => l.slug);

    // Run 2 leagues at a time (each uses up to 5 DB connections → max 10 total).
    const results = await withConcurrency(
      slugs,
      slug => computeTipsForLeague(slug).catch(() => ({ matches: [] })),
      2
    );

    const bundle = {};
    slugs.forEach((slug, i) => { bundle[slug] = results[i]; });

    return res.json(bundle);
  } catch (e) {
    console.error("[Tips] getTipsBundle error:", e.message);
    return res.status(500).json({});
  }
}

// ── GET /api/tips/:matchId?league=<slug> ──────────────────────
// Returns full prediction. Persists to DB on first generation.

async function getMatchTip(req, res) {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  const slug  = resolveLeagueSlug(req);
  const isIPL = slug === "ipl";

  const memKey = `tips:full:${matchId}`;
  const dbKey  = `pred:full:${matchId}`;

  try {
    // 1. Memory cache
    const mem = getCache(memKey);
    if (mem) {
      console.log(`[Tips] memory hit for ${matchId}`);
      return res.json(mem);
    }

    // 2. Supabase DB
    const stored = await db.getCachedData(dbKey, PRED_TTL_DB);
    if (stored) {
      console.log(`[Tips] DB hit for ${matchId}`);
      setCache(memKey, stored, PRED_TTL_MEM);
      return res.json(stored);
    }

    // 3. Generate
    let match, tip;
    if (isIPL) {
      const allMatches = await iplService.getIPLMatches();
      const numId = Number(matchId);
      match = [
        ...allMatches.live,
        ...allMatches.upcoming,
        ...allMatches.completed,
      ].find(m => m.id === numId || String(m.id) === matchId);

      if (!match) return res.status(404).json({ error: "Match not found" });

      const squad = await db.getSquad(matchId).catch(() => null);
      tip = await tipsService.getMatchTip(match, squad);
    } else {
      const league = getLeague(slug);
      if (!league || league.sport !== "cricket") {
        return res.status(404).json({ error: "League not found" });
      }

      const [leagueMatches, table] = await Promise.all([
        leagueService.getLeagueMatches(league),
        leagueService.getLeagueTable(league),
      ]);
      const numId = Number(matchId);
      match = [
        ...leagueMatches.live,
        ...leagueMatches.upcoming,
        ...leagueMatches.completed,
      ].find(m => m.id === numId || String(m.id) === matchId);

      if (!match) return res.status(404).json({ error: "Match not found" });

      tip = await genericTips.getMatchTip(match, table, leagueMatches.completed, slug);
    }

    if (!tip) return res.status(422).json({ error: "Could not generate prediction" });

    const payload = { match, tip };
    setCache(memKey, payload, PRED_TTL_MEM);
    void db.setCachedData(dbKey, payload);  // persist forever
    console.log(`[Tips] stored full prediction for match ${matchId}`);
    return res.json(payload);
  } catch (e) {
    console.error(`[Tips] getMatchTip(${matchId}) error:`, e.message);
    return res.status(500).json({ error: "Failed to generate tip" });
  }
}

module.exports = { getTipsList, getMatchTip, getPersistentLightTip, computeTipsForLeague, getTipsBundle };
