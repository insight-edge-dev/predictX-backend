const iplService     = require("../services/iplService");
const leagueService  = require("../services/leagueService");
const tipsService    = require("../services/tipsService");
const genericTips    = require("../services/genericTipsService");
const db             = require("../services/dbService");
const { getCache, setCache, TTL } = require("../services/cacheService");
const { getLeague }  = require("../config/leaguesConfig");

// Predictions are static (pre-match historical data) — never expire in DB.
const PRED_TTL_DB  = 365 * 24 * 60 * 60_000; // 1 year
const PRED_TTL_MEM = TTL.DAILY;               // 24 h in memory

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
//
// `ctx.isIPL === true`  → uses tipsService (7-factor IPL model, unchanged)
// `ctx.isIPL === false` → uses genericTips (current-season model for other leagues)

async function getPersistentLightTip(match, ctx) {
  const memKey = `tips:light:${match.id}`;
  const dbKey  = `pred:light:${match.id}`;

  // 1. Memory cache (fastest)
  const mem = getCache(memKey);
  if (mem) return mem;

  // 2. Supabase DB (survives restarts)
  const stored = await db.getCachedData(dbKey, PRED_TTL_DB);
  if (stored) {
    setCache(memKey, stored, PRED_TTL_MEM);
    return stored;
  }

  // 3. Generate and persist
  const tip = ctx.isIPL
    ? await tipsService.getLightweightTip(match)
    : await genericTips.getLightweightTip(match, ctx.table, ctx.completed, ctx.slug);

  if (tip) {
    setCache(memKey, tip, PRED_TTL_MEM);
    void db.setCachedData(dbKey, tip);  // fire-and-forget write to DB
    console.log(`[Tips] stored prediction for match ${match.id}`);
  }
  return tip;
}

// ── GET /api/tips?league=<slug> ───────────────────────────────
// Returns live + upcoming + recent completed matches with predictions.
// `league` defaults to IPL (unchanged behaviour for existing callers).

async function getTipsList(req, res) {
  const slug  = resolveLeagueSlug(req);
  const isIPL = slug === "ipl";
  const cacheKey = isIPL ? "tips:list" : `tips:list:${slug}`;

  try {
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    let matches, ctx;
    if (isIPL) {
      matches = await iplService.getIPLMatches();
      ctx = { isIPL: true };
    } else {
      const league = getLeague(slug);
      if (!league || league.sport !== "cricket") {
        const empty = { matches: [] };
        setCache(cacheKey, empty, 30 * 60_000);
        return res.json(empty);
      }
      const [leagueMatches, table] = await Promise.all([
        leagueService.getLeagueMatches(league),
        leagueService.getLeagueTable(league),
      ]);
      matches = leagueMatches;
      ctx = { isIPL: false, table, completed: matches.completed, slug };
    }

    // Include ALL completed matches so prediction badges show for the full season
    const tippable = [...matches.live, ...matches.upcoming, ...matches.completed];

    const withTips = await Promise.all(
      tippable.map(async (m) => {
        try {
          const tip = await getPersistentLightTip(m, ctx);
          return { ...m, tip: tip ?? null };
        } catch {
          return { ...m, tip: null };
        }
      })
    );

    const payload = { matches: withTips };
    setCache(cacheKey, payload, 30 * 60_000);
    return res.json(payload);
  } catch (e) {
    console.error("[Tips] getTipsList error:", e.message);
    return res.status(500).json({ matches: [] });
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

module.exports = { getTipsList, getMatchTip };
