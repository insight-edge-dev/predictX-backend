const iplService   = require("../services/iplService");
const tipsService  = require("../services/tipsService");
const db           = require("../services/dbService");
const { getCache, setCache, TTL } = require("../services/cacheService");

// Predictions are static (pre-match historical data) — never expire in DB.
const PRED_TTL_DB  = 365 * 24 * 60 * 60_000; // 1 year
const PRED_TTL_MEM = TTL.DAILY;               // 24 h in memory

// ── Persistent lightweight tip ────────────────────────────────
// Check memory → DB → generate.  Writes to DB on first generation
// so the prediction survives server restarts forever.

async function getPersistentLightTip(match) {
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
  const tip = await tipsService.getLightweightTip(match);
  if (tip) {
    setCache(memKey, tip, PRED_TTL_MEM);
    void db.setCachedData(dbKey, tip);  // fire-and-forget write to DB
    console.log(`[Tips] stored prediction for match ${match.id}`);
  }
  return tip;
}

// ── GET /api/tips ─────────────────────────────────────────────
// Returns live + upcoming + recent completed matches with predictions.
// Completed matches (last 14 days) use stored predictions from DB.

async function getTipsList(req, res) {
  const cacheKey = "tips:list";
  try {
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const matches = await iplService.getIPLMatches();

    // Include ALL completed matches so prediction badges show for the full season
    const recentCompleted = matches.completed;

    const tippable = [...matches.live, ...matches.upcoming, ...recentCompleted];

    const withTips = await Promise.all(
      tippable.map(async (m) => {
        try {
          const tip = await getPersistentLightTip(m);
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

// ── GET /api/tips/:matchId ────────────────────────────────────
// Returns full prediction. Persists to DB on first generation.

async function getMatchTip(req, res) {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

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
    const allMatches = await iplService.getIPLMatches();
    const numId = Number(matchId);
    const match = [
      ...allMatches.live,
      ...allMatches.upcoming,
      ...allMatches.completed,
    ].find(m => m.id === numId || String(m.id) === matchId);

    if (!match) return res.status(404).json({ error: "Match not found" });

    const squad = await db.getSquad(matchId).catch(() => null);
    const tip   = await tipsService.getMatchTip(match, squad);
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
