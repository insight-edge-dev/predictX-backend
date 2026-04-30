const iplService   = require("../services/iplService");
const tipsService  = require("../services/tipsService");
const db           = require("../services/dbService");
const { getCache, setCache, TTL } = require("../services/cacheService");

// ── GET /api/tips ─────────────────────────────────────────────
// Returns upcoming + live matches each with a lightweight win% prediction.

async function getTipsList(req, res) {
  const cacheKey = "tips:list";
  try {
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const matches = await iplService.getIPLMatches();
    const tippable = [...matches.live, ...matches.upcoming];

    // Attach lightweight predictions in parallel (best-effort — never block list)
    const withTips = await Promise.all(
      tippable.map(async (m) => {
        try {
          const tip = await tipsService.getLightweightTip(m);
          return { ...m, tip };
        } catch {
          return { ...m, tip: null };
        }
      })
    );

    const payload = { matches: withTips };
    setCache(cacheKey, payload, 30 * 60_000); // 30 min cache
    return res.json(payload);
  } catch (e) {
    console.error("[Tips] getTipsList error:", e.message);
    return res.status(500).json({ matches: [] });
  }
}

// ── GET /api/tips/:matchId ────────────────────────────────────
// Returns full prediction for a single match.

async function getMatchTip(req, res) {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  const cacheKey = `tips:${matchId}`;

  try {
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`[Tips] cache hit for ${matchId}`);
      return res.json(cached);
    }

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
    setCache(cacheKey, payload, TTL.FIXTURES); // 6h cache
    return res.json(payload);
  } catch (e) {
    console.error(`[Tips] getMatchTip(${matchId}) error:`, e.message);
    return res.status(500).json({ error: "Failed to generate tip" });
  }
}

module.exports = { getTipsList, getMatchTip };
