/**
 * footballAPIService.js — football-data.org v4 wrapper.
 *
 * Base URL: https://api.football-data.org/v4
 * Auth header: X-Auth-Token (env: FOOTBALL_DATA_ORG_TOKEN)
 * Free tier: 10 requests/minute — our 3-tier cache keeps us well within this.
 *
 * Confirmed endpoints (WC 2026 = competition code "WC"):
 *   GET /competitions/WC/matches?season=2026
 *   GET /competitions/WC/standings?season=2026
 *   GET /matches/<id>
 *
 * Has the full real WC 2026 schedule — 72 group-stage + 32 knockout matches
 * (knockout fixtures carry placeholder dates with homeTeam/awayTeam = null
 * until the bracket fills in).
 */

const axios = require("axios");

const BASE_URL = "https://api.football-data.org/v4";
const WC_CODE  = "WC";
const SEASON   = 2026;

const headers = {
  "X-Auth-Token": process.env.FOOTBALL_DATA_ORG_TOKEN || "",
};

const client = axios.create({ baseURL: BASE_URL, headers, timeout: 15000 });

// ── Fixtures ──────────────────────────────────────────────────────

/**
 * All fixtures (group stage + knockout) for the WC 2026 season.
 * Returns the raw `matches` array from the API.
 */
async function getFixtures() {
  try {
    const res = await client.get(`/competitions/${WC_CODE}/matches`, { params: { season: SEASON } });
    return res.data.matches ?? [];
  } catch (e) {
    console.warn("[FootballAPI] getFixtures failed:", e.response?.data?.message || e.message);
    return [];
  }
}

/**
 * Single match detail by football-data.org match id.
 */
async function getMatchDetail(matchId) {
  try {
    const res = await client.get(`/matches/${matchId}`);
    return res.data ?? null;
  } catch {
    return null;
  }
}

// ── Standings ─────────────────────────────────────────────────────

/**
 * Standings for the WC 2026 season — returns TOTAL/HOME/AWAY table views.
 * Each table is a flat 48-team list (group assignment derived from our
 * WC2026_TEAMS registry via the team's FIFA code).
 * Returns [] before the tournament starts (group play hasn't begun).
 */
async function getStandings() {
  try {
    const res = await client.get(`/competitions/${WC_CODE}/standings`, { params: { season: SEASON } });
    return res.data.standings ?? [];
  } catch (e) {
    console.warn("[FootballAPI] getStandings failed:", e.response?.data?.message || e.message);
    return [];
  }
}

module.exports = {
  getFixtures,
  getMatchDetail,
  getStandings,
};
