/**
 * seriesController.js — handlers for /api/series/* routes.
 * For IPL app: series = IPL season, powered by Sportsmonks fixtures.
 */

const { getIPLFixtures, getIPLTable } = require("../services/iplService");
const { getCache, setCache, TTL, KEYS } = require("../services/cacheService");

// ── GET /api/series ───────────────────────────────────────────
// Returns the single active series (IPL 2026).

async function getSeriesList(req, res) {
  try {
    return res.json({
      series: [{
        id:        "ipl-2026",
        name:      "Indian Premier League 2026",
        startDate: "2026-03-22",
        endDate:   "2026-05-25",
        t20:       74,
        matches:   74,
      }],
    });
  } catch (e) {
    return res.status(500).json({ series: [] });
  }
}

// ── GET /api/series/:id ───────────────────────────────────────

async function getSeriesById(req, res) {
  try {
    const matches = await getIPLFixtures();
    const table   = await getIPLTable();
    return res.json({
      series: { id: "ipl-2026", name: "Indian Premier League 2026" },
      matches,
      table,
    });
  } catch (e) {
    console.error("[Series] getSeriesById:", e.message);
    return res.status(500).json({ error: "Failed to fetch series" });
  }
}

// ── GET /api/series/:id/table ─────────────────────────────────

async function getSeriesTable(req, res) {
  try {
    const table = await getIPLTable();
    return res.json({ table });
  } catch (e) {
    return res.status(500).json({ table: [] });
  }
}

// ── GET /api/series/:id/matches ───────────────────────────────

async function getSeriesMatches(req, res) {
  try {
    const matches = await getIPLFixtures();
    return res.json({ matches });
  } catch (e) {
    return res.status(500).json({ matches: [] });
  }
}

module.exports = { getSeriesList, getSeriesById, getSeriesTable, getSeriesMatches };
