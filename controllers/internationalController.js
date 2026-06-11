const international = require("../services/internationalService");
const intlTips      = require("../services/internationalPredictionService");
const db            = require("../services/dbService");
const { getCache, setCache, TTL } = require("../services/cacheService");

// Predictions are static (pre-match historical data) — never expire in DB.
// Same key namespace as tipsController so AI-correct/wrong badges work
// uniformly everywhere a match shows up (Sportsmonks fixture IDs are globally
// unique, so no collisions with IPL/other-league predictions).
const PRED_TTL_DB  = 365 * 24 * 60 * 60_000; // 1 year
const PRED_TTL_MEM = TTL.DAILY;               // 24 h in memory

function leagueIdFor(slug) {
  return international.INTERNATIONAL_LEAGUES[slug]?.leagueId ?? null;
}

async function getPersistentLightTip(match, completed, leagueId) {
  const memKey = `tips:light:${match.id}`;
  const dbKey  = `pred:light:${match.id}`;

  const mem = getCache(memKey);
  if (mem) return mem;

  const stored = await db.getCachedData(dbKey, PRED_TTL_DB);
  if (stored) {
    setCache(memKey, stored, PRED_TTL_MEM);
    return stored;
  }

  const tip = await intlTips.getLightweightTip(match, completed, leagueId);
  if (tip) {
    setCache(memKey, tip, PRED_TTL_MEM);
    void db.setCachedData(dbKey, tip);
    console.log(`[IntlTips] stored prediction for match ${match.id}`);
  }
  return tip;
}

// ── GET /api/international/series ─────────────────────────────

async function getSeriesList(req, res) {
  try {
    const cacheKey = "intl:series:list:all";
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const series = await international.getSeriesList();
    const payload = { series };
    setCache(cacheKey, payload, TTL.INTL_SERIES);
    return res.json(payload);
  } catch (e) {
    console.error("[Intl] getSeriesList error:", e.message);
    return res.status(500).json({ series: [] });
  }
}

// ── GET /api/international/series/:stageId ────────────────────
// Returns the series' matches, each carrying a lightweight prediction
// (same { ...match, tip } shape the cricket matches screen already expects).

async function getSeriesDetail(req, res) {
  const { stageId } = req.params;
  if (!stageId) return res.status(400).json({ error: "stageId required" });

  try {
    const cacheKey = `intl:series:detail:full:${stageId}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const detail = await international.getSeriesDetail(stageId);
    if (!detail) return res.status(404).json({ error: "Series not found" });

    const leagueId = leagueIdFor(detail.series.leagueSlug);
    const { live, upcoming, completed } = detail.matches;
    const tippable = [...live, ...upcoming, ...completed];

    const withTips = await Promise.all(
      tippable.map(async (m) => {
        try {
          const tip = await getPersistentLightTip(m, completed, leagueId);
          return { ...m, tip: tip ?? null };
        } catch {
          return { ...m, tip: null };
        }
      })
    );

    const byId = new Map(withTips.map(m => [m.id, m]));
    const payload = {
      series: detail.series,
      matches: {
        live:      live.map(m => byId.get(m.id) ?? m),
        upcoming:  upcoming.map(m => byId.get(m.id) ?? m),
        completed: completed.map(m => byId.get(m.id) ?? m),
      },
    };

    setCache(cacheKey, payload, live.length > 0 ? TTL.LIVE : TTL.INTL_SERIES);
    return res.json(payload);
  } catch (e) {
    console.error(`[Intl] getSeriesDetail(${stageId}) error:`, e.message);
    return res.status(500).json({ error: "Failed to load series" });
  }
}

// ── GET /api/international/tips/:matchId ───────────────────────
// Full prediction (factors, H2H, form) — persists to DB on first generation.

async function getMatchTip(req, res) {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  const memKey = `tips:full:${matchId}`;
  const dbKey  = `pred:full:${matchId}`;

  try {
    const mem = getCache(memKey);
    if (mem) return res.json(mem);

    const stored = await db.getCachedData(dbKey, PRED_TTL_DB);
    if (stored) {
      setCache(memKey, stored, PRED_TTL_MEM);
      return res.json(stored);
    }

    const found = await international.findMatch(matchId);
    if (!found) return res.status(404).json({ error: "Match not found" });

    const { match, fixtures, leagueId } = found;
    const seriesMatches = fixtures.filter(m => m.stageId === match.stageId);
    const completed = seriesMatches.filter(m => m.status === "completed" || m.isCompleted);

    const tip = await intlTips.getMatchTip(match, completed, leagueId);
    if (!tip) return res.status(422).json({ error: "Could not generate prediction" });

    const payload = { match, tip };
    setCache(memKey, payload, PRED_TTL_MEM);
    void db.setCachedData(dbKey, payload);
    console.log(`[IntlTips] stored full prediction for match ${matchId}`);
    return res.json(payload);
  } catch (e) {
    console.error(`[Intl] getMatchTip(${matchId}) error:`, e.message);
    return res.status(500).json({ error: "Failed to generate tip" });
  }
}

module.exports = { getSeriesList, getSeriesDetail, getMatchTip };
