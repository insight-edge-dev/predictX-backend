/**
 * footballController.js — Thin request handlers for football endpoints.
 * All business logic lives in footballService / footballPredictionService.
 */

const footballService    = require("../services/footballService");
const predictionService  = require("../services/footballPredictionService");
const wcHistory          = require("../services/wcHistoryLoader");
const { getCache, setCache, TTL, KEYS } = require("../services/cacheService");

// ── GET /api/football/matches ──────────────────────────────────────
async function getMatches(req, res) {
  try {
    const data = await footballService.getMatches();
    res.json(data);
  } catch (e) {
    console.error("[Football] getMatches:", e.message);
    res.status(500).json({ error: "Failed to fetch football matches" });
  }
}

// ── GET /api/football/matches/live ────────────────────────────────
async function getLive(req, res) {
  try {
    const live = await footballService.getLiveMatches();
    res.json({ live });
  } catch (e) {
    console.error("[Football] getLive:", e.message);
    res.status(500).json({ error: "Failed to fetch live football matches" });
  }
}

// ── GET /api/football/matches/upcoming ────────────────────────────
async function getUpcoming(req, res) {
  try {
    const { upcoming } = await footballService.getMatches();
    res.json({ upcoming });
  } catch (e) {
    console.error("[Football] getUpcoming:", e.message);
    res.status(500).json({ error: "Failed to fetch upcoming matches" });
  }
}

// ── GET /api/football/matches/results ─────────────────────────────
async function getResults(req, res) {
  try {
    const { completed } = await footballService.getMatches();
    res.json({ completed });
  } catch (e) {
    console.error("[Football] getResults:", e.message);
    res.status(500).json({ error: "Failed to fetch match results" });
  }
}

// ── GET /api/football/matches/:id ─────────────────────────────────
async function getMatchById(req, res) {
  try {
    const match = await footballService.getMatchById(req.params.id);
    if (!match) return res.status(404).json({ error: "Match not found" });
    res.json({ match });
  } catch (e) {
    console.error("[Football] getMatchById:", e.message);
    res.status(500).json({ error: "Failed to fetch match detail" });
  }
}

// ── GET /api/football/tips ────────────────────────────────────────
async function getTipsList(req, res) {
  try {
    const cacheKey = KEYS.FOOTBALL_TIPS_LIST;
    const cached   = getCache(cacheKey);
    if (cached) return res.json({ matches: cached });

    const { live, upcoming, completed } = await footballService.getMatches();
    // Include completed matches so prediction-accuracy badges can be shown
    const targets = [...live, ...upcoming.slice(0, 20), ...completed];

    // Attach lightweight predictions in parallel
    const matches = await Promise.all(
      targets.map(async (match) => {
        const tip = await predictionService.getLightweightPrediction(match).catch(() => null);
        return { ...match, tip };
      })
    );

    setCache(cacheKey, matches, TTL.FOOTBALL_FIXTURES);
    res.json({ matches });
  } catch (e) {
    console.error("[Football] getTipsList:", e.message);
    res.status(500).json({ error: "Failed to fetch football tips" });
  }
}

// ── GET /api/football/tips/:matchId ───────────────────────────────
async function getMatchTip(req, res) {
  try {
    const match = await footballService.getMatchById(req.params.matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    const tip = await predictionService.getMatchPrediction(match);
    res.json({ match, tip });
  } catch (e) {
    console.error("[Football] getMatchTip:", e.message);
    res.status(500).json({ error: "Failed to fetch match prediction" });
  }
}

// ── GET /api/football/groups ──────────────────────────────────────
async function getGroups(req, res) {
  try {
    const groups = await footballService.getGroups();
    res.json({ groups });
  } catch (e) {
    console.error("[Football] getGroups:", e.message);
    res.status(500).json({ error: "Failed to fetch group standings" });
  }
}

// ── GET /api/football/groups/:group ───────────────────────────────
async function getGroup(req, res) {
  try {
    const groups = await footballService.getGroups();
    const letter = req.params.group.toUpperCase();
    const group  = groups[`Group ${letter}`] ?? groups[letter] ?? null;
    if (!group) return res.status(404).json({ error: `Group ${letter} not found` });
    res.json({ group });
  } catch (e) {
    console.error("[Football] getGroup:", e.message);
    res.status(500).json({ error: "Failed to fetch group" });
  }
}

// ── GET /api/football/wc-history ──────────────────────────────────
async function getWCHistory(_req, res) {
  try {
    const cacheKey = "football:wc:stats";
    const cached   = getCache(cacheKey);
    if (cached) return res.json(cached);

    const stats = wcHistory.getWCStats();
    setCache(cacheKey, stats, TTL.DAILY);
    res.json(stats);
  } catch (e) {
    console.error("[Football] getWCHistory:", e.message);
    res.status(500).json({ error: "Failed to compute WC history stats" });
  }
}

module.exports = {
  getMatches,
  getLive,
  getUpcoming,
  getResults,
  getMatchById,
  getTipsList,
  getMatchTip,
  getGroups,
  getGroup,
  getWCHistory,
};
