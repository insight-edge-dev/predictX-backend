/**
 * iplController.js — HTTP handlers for IPL-specific endpoints.
 *
 * Routes:
 *   GET /api/ipl/matches   → { live, upcoming, completed }
 *   GET /api/ipl/live      → { live }
 *   GET /api/ipl/upcoming  → { upcoming }
 *   GET /api/ipl/results   → { completed }
 *   GET /api/ipl/fixtures  → { fixtures }
 *   GET /api/ipl/table     → { table }
 */

const iplService = require("../services/iplService");

// ── GET /api/ipl/matches ──────────────────────────────────────

async function getMatches(req, res) {
  try {
    const data = await iplService.getIPLMatches();
    res.json(data);
  } catch (e) {
    console.error("[IPL] getMatches:", e.message);
    res.status(500).json({ error: "Failed to fetch IPL matches" });
  }
}

// ── GET /api/ipl/live ─────────────────────────────────────────

async function getLive(req, res) {
  try {
    const { live } = await iplService.getIPLMatches();
    res.json({ live });
  } catch (e) {
    console.error("[IPL] getLive:", e.message);
    res.status(500).json({ error: "Failed to fetch live IPL matches" });
  }
}

// ── GET /api/ipl/upcoming ─────────────────────────────────────

async function getUpcoming(req, res) {
  try {
    const { upcoming } = await iplService.getIPLMatches();
    res.json({ upcoming });
  } catch (e) {
    console.error("[IPL] getUpcoming:", e.message);
    res.status(500).json({ error: "Failed to fetch upcoming IPL matches" });
  }
}

// ── GET /api/ipl/results ──────────────────────────────────────

async function getResults(req, res) {
  try {
    const { completed } = await iplService.getIPLMatches();
    res.json({ completed });
  } catch (e) {
    console.error("[IPL] getResults:", e.message);
    res.status(500).json({ error: "Failed to fetch IPL results" });
  }
}

// ── GET /api/ipl/fixtures ─────────────────────────────────────

async function getFixtures(req, res) {
  try {
    const fixtures = await iplService.getIPLFixtures();
    res.json({ fixtures });
  } catch (e) {
    console.error("[IPL] getFixtures:", e.message);
    res.status(500).json({ error: "Failed to fetch IPL fixtures" });
  }
}

// ── GET /api/ipl/table ────────────────────────────────────────

async function getTable(req, res) {
  try {
    const table = await iplService.getIPLTable();
    res.json({ table });
  } catch (e) {
    console.error("[IPL] getTable:", e.message);
    res.status(500).json({ error: "Failed to fetch IPL points table" });
  }
}

module.exports = { getMatches, getLive, getUpcoming, getResults, getFixtures, getTable };
