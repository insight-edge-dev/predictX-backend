/**
 * highlightController.js — Serve Highlightly video highlights.
 *
 * Routes:
 *   GET /api/highlights             — Recent highlights (all or filtered)
 *   GET /api/highlights/match/:id   — Highlights for a specific match
 *   GET /api/highlights/league/:id  — Highlights for a specific league
 */

const storage = require("../services/highlightlyStorageService");
const { getCache, setCache } = require("../services/cacheService");

// ── GET /api/highlights ───────────────────────────────────────
// Query params: sport, category, leagueId, limit
async function getHighlights(req, res) {
  try {
    const sport    = req.query.sport    || null;
    const category = req.query.category || null;
    const leagueId = req.query.leagueId || null;
    const limit    = Math.min(Number(req.query.limit) || 40, 100);

    const cacheKey = `highlights:${sport}:${category}:${leagueId}:${limit}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ highlights: cached });

    let highlights;
    if (leagueId) {
      highlights = await storage.getLeagueHighlights(leagueId, limit);
      if (sport) highlights = highlights.filter(h => h.sport === sport);
      if (category) highlights = highlights.filter(h => h.category === category);
    } else {
      highlights = await storage.getRecentHighlights({ sport, category, limit });
    }

    setCache(cacheKey, highlights, 5); // 5-minute cache
    res.json({ highlights });
  } catch (e) {
    console.error("[Highlights] getHighlights:", e.message);
    res.status(500).json({ error: "Failed to fetch highlights" });
  }
}

// ── GET /api/highlights/match/:id ─────────────────────────────
async function getMatchHighlights(req, res) {
  try {
    const matchId  = req.params.id;
    const cacheKey = `highlights:match:${matchId}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ highlights: cached });

    const highlights = await storage.getHighlights(matchId);
    setCache(cacheKey, highlights, 5);
    res.json({ highlights });
  } catch (e) {
    console.error("[Highlights] getMatchHighlights:", e.message);
    res.status(500).json({ error: "Failed to fetch match highlights" });
  }
}

// ── GET /api/highlights/league/:id ───────────────────────────
async function getLeagueHighlights(req, res) {
  try {
    const leagueId = req.params.id;
    const limit    = Math.min(Number(req.query.limit) || 30, 100);
    const category = req.query.category || null;

    const cacheKey = `highlights:league:${leagueId}:${category}:${limit}`;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ highlights: cached });

    let highlights = await storage.getLeagueHighlights(leagueId, limit);
    if (category) highlights = highlights.filter(h => h.category === category);

    setCache(cacheKey, highlights, 5);
    res.json({ highlights });
  } catch (e) {
    console.error("[Highlights] getLeagueHighlights:", e.message);
    res.status(500).json({ error: "Failed to fetch league highlights" });
  }
}

module.exports = { getHighlights, getMatchHighlights, getLeagueHighlights };
