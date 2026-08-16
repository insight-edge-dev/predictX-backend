/**
 * highlightlyService.js — HTTP client for the Highlightly All Sports API.
 *
 * Base URL : https://sports.highlightly.net
 * Auth     : x-rapidapi-key header (direct Highlightly subscription)
 *
 * All functions throw on API error so callers can catch and fall back
 * to stored DB data. No silent swallowing here — errors are the caller's
 * responsibility to handle.
 */

const axios = require("axios");
const { highlightlyLimiter } = require("./apiRateLimiter");

const BASE_URL = "https://sports.highlightly.net";
const API_KEY  = process.env.HIGHLIGHTLY_API_KEY;

const http = axios.create({
  baseURL:  BASE_URL,
  timeout:  15_000,
  headers:  { "x-rapidapi-key": API_KEY },
});

// ── 429 circuit breaker ───────────────────────────────────────
// When the daily limit is hit, block all outbound calls for 5 minutes
// so the error log doesn't flood and we stop wasting the remaining quota.

let _rateLimitedUntil = 0;

function isRateLimited() {
  return Date.now() < _rateLimitedUntil;
}

// ── Internal helper ───────────────────────────────────────────

async function _get(path, params = {}) {
  if (Date.now() < _rateLimitedUntil) {
    const waitSec = Math.ceil((_rateLimitedUntil - Date.now()) / 1_000);
    throw new Error(`[Highlightly] ${path} → rate-limited, resuming in ${waitSec}s`);
  }

  // Proactive rate limit: wait for a token (max 30 req/min, burst of 5).
  // This prevents triggering the 429 circuit breaker in the first place.
  await highlightlyLimiter.acquire();

  // Strip undefined values so they don't appear as "undefined" strings
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  );
  try {
    const { data, headers } = await http.get(path, { params: cleanParams });
    // Adaptive rate limiting — use server-reported quota when available
    highlightlyLimiter.updateFromHeaders(headers);
    return data;
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    if (status === 429) {
      _rateLimitedUntil = Date.now() + 5 * 60_000;
      console.warn(`[Highlightly] 429 daily limit hit — pausing all calls for 5 min (until ${new Date(_rateLimitedUntil).toTimeString().slice(0, 8)})`);
    }
    throw new Error(`[Highlightly] ${path} → HTTP ${status ?? "ERR"}: ${msg}`);
  }
}

// ── Cricket ───────────────────────────────────────────────────

/**
 * Fetch cricket matches.
 * Filters: date (YYYY-MM-DD), leagueId, season, limit, offset
 */
async function getMatches(params = {}) {
  const res = await _get("/cricket/matches", params);
  return Array.isArray(res) ? res : (res.data || []);
}

/**
 * Fetch full match detail (scorecard, batting, bowling).
 * Returns the first element of the array Highlightly wraps around it.
 */
async function getMatchDetail(matchId) {
  const res = await _get(`/cricket/matches/${matchId}`);
  return Array.isArray(res) ? (res[0] ?? null) : res;
}

/** Fetch league list. Filters: leagueName, countryCode, limit, offset */
async function getLeagues(params = {}) {
  const res = await _get("/cricket/leagues", params);
  return res; // returns { data, pagination, plan }
}

/** Fetch standings for a specific league season. */
async function getStandings(leagueId, season) {
  const res = await _get("/cricket/standings", { leagueId, season });
  return res; // returns { groups: [{ groupName, standings: [...] }] }
}

/** Fetch highlight clips. Filters: leagueId, season, matchId, date, limit */
async function getHighlights(params = {}) {
  const res = await _get("/cricket/highlights", params);
  return Array.isArray(res) ? res : (res.data || []);
}

/** Fetch team list. Filters: name, limit, offset */
async function getTeams(params = {}) {
  const res = await _get("/cricket/teams", params);
  return res.data || [];
}

/** Fetch player list. Filters: name, limit, offset */
async function getPlayers(params = {}) {
  const res = await _get("/cricket/players", params);
  return res.data || [];
}

/** Fetch head-to-head match history between two teams. */
async function getHeadToHead(teamIdOne, teamIdTwo) {
  const res = await _get("/cricket/head-2-head", { teamIdOne, teamIdTwo });
  return Array.isArray(res) ? res : [];
}

// ── Football ──────────────────────────────────────────────────

/** Fetch football matches. Filters: date, leagueId, season, limit, offset */
async function getFootballMatches(params = {}) {
  const res = await _get("/football/matches", params);
  return Array.isArray(res) ? res : (res.data || []);
}

/** Fetch football match detail (events, stats, lineups). */
async function getFootballMatchDetail(matchId) {
  const res = await _get(`/football/matches/${matchId}`);
  return Array.isArray(res) ? (res[0] ?? null) : res;
}

/** Fetch football leagues. Filters: leagueName, countryCode, season, limit */
async function getFootballLeagues(params = {}) {
  const res = await _get("/football/leagues", params);
  return res.data || [];
}

/** Fetch football standings. */
async function getFootballStandings(leagueId, season) {
  return _get("/football/standings", { leagueId, season });
}

/** Fetch football highlights. Filters: leagueId, matchId, date, limit */
async function getFootballHighlights(params = {}) {
  const res = await _get("/football/highlights", params);
  return Array.isArray(res) ? res : (res.data || []);
}

/** Fetch last 5 games for a football team. */
async function getLastFiveGames(teamId) {
  const res = await _get("/football/last-five-games", { teamId });
  return res.data || [];
}

/** Fetch football head-to-head. */
async function getFootballH2H(teamIdOne, teamIdTwo) {
  const res = await _get("/football/head-2-head", { teamIdOne, teamIdTwo });
  return res.data || [];
}

/** Fetch last 5 completed matches for a cricket team. */
async function getCricketLastFiveGames(teamId) {
  const res = await _get("/cricket/last-five-games", { teamId });
  return Array.isArray(res) ? res : (res.data || []);
}

/** Fetch full cricket player profile (career stats, bio, news). */
async function getCricketPlayerDetail(playerId) {
  const res = await _get(`/cricket/players/${playerId}`);
  return Array.isArray(res) ? (res[0] ?? null) : res;
}

/** Fetch starting lineups for a football match. Available ~30 min before KO. */
async function getFootballLineups(matchId) {
  const res = await _get(`/football/lineups/${matchId}`);
  return Array.isArray(res) ? (res[0] ?? res) : res;
}

module.exports = {
  // Rate-limit state
  isRateLimited,
  // Cricket
  getMatches,
  getMatchDetail,
  getLeagues,
  getStandings,
  getHighlights,
  getTeams,
  getPlayers,
  getHeadToHead,
  getCricketLastFiveGames,
  getCricketPlayerDetail,
  // Football
  getFootballMatches,
  getFootballMatchDetail,
  getFootballLeagues,
  getFootballStandings,
  getFootballHighlights,
  getLastFiveGames,
  getFootballH2H,
  getFootballLineups,
};
