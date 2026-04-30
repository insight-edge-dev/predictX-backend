/**
 * sportmonksService.js — Sportsmonks Cricket API v2 HTTP layer.
 *
 * All endpoints return response.data (unwrapped).
 * Never throws — returns null on any failure.
 * Backs off 2 min on 429.
 *
 * IPL constants (hardcoded — never change mid-season):
 *   league_id  = 1
 *   season_id  = 1795  (IPL 2026)
 *   stage_id   = 6468  (Regular Season standings)
 *   playoff_id = 6469  (Play Offs standings)
 */

const axios = require("axios");

const BASE        = "https://cricket.sportmonks.com/api/v2.0";
const TIMEOUT_MS  = 12_000;

// IPL 2026 identifiers
const IPL_LEAGUE_ID  = 1;
const IPL_SEASON_ID  = Number(process.env.IPL_SEASON_ID  || 1795);
const IPL_STAGE_ID   = Number(process.env.IPL_STAGE_ID   || 6468);
const IPL_PLAYOFF_ID = Number(process.env.IPL_PLAYOFF_ID || 6469);

// Rate-limit state
let _rateLimitUntil = 0;

function _key() {
  return process.env.SPORTMONKS_API_KEY || "";
}

// ── Core fetch ────────────────────────────────────────────────

async function _fetch(endpoint, params = {}) {
  const key = _key();
  if (!key) {
    console.warn("[SM] SPORTMONKS_API_KEY not set");
    return null;
  }

  if (Date.now() < _rateLimitUntil) {
    const secs = Math.ceil((_rateLimitUntil - Date.now()) / 1000);
    console.log(`[SM] rate-limit backoff — ${secs}s left, skipping ${endpoint}`);
    return null;
  }

  try {
    const { data } = await axios.get(`${BASE}${endpoint}`, {
      params:  { api_token: key, ...params },
      timeout: TIMEOUT_MS,
    });
    return data?.data ?? null;
  } catch (e) {
    if (e.response?.status === 429) {
      _rateLimitUntil = Date.now() + 2 * 60_000;
      console.warn("[SM] 429 — backing off 2 min");
    } else {
      console.error(`[SM] ${endpoint} error:`, e.response?.status ?? e.message);
    }
    return null;
  }
}

// ── Fixtures ──────────────────────────────────────────────────

/**
 * All IPL 2026 fixtures with localteam/visitorteam/runs.
 * Used for fixtures list, matches list, and standings computation.
 */
async function getIPLFixtures() {
  return _fetch("/fixtures", {
    "filter[season_id]": IPL_SEASON_ID,
    include: "localteam,visitorteam,runs",
    per_page: 100,
  });
}

/**
 * Single fixture with full scorecard detail.
 * Includes batting/bowling with player names, scoreboards, venue.
 */
async function getFixtureDetail(fixtureId) {
  return _fetch(`/fixtures/${fixtureId}`, {
    include: "localteam,visitorteam,runs,batting.batsman,bowling.bowler,scoreboards,venue",
  });
}

/**
 * Currently live matches (all leagues — we filter for IPL downstream).
 */
async function getLivescores() {
  return _fetch("/livescores", {
    include: "localteam,visitorteam,runs",
  });
}

// ── Squads ────────────────────────────────────────────────────

/**
 * Team squad for a specific season.
 * Returns data.squad[] array with player objects + position.
 */
async function getTeamSquad(teamId, seasonId = IPL_SEASON_ID) {
  const raw = await _fetch(`/teams/${teamId}/squad/${seasonId}`);
  return raw?.squad ?? null;
}

// ── Standings ─────────────────────────────────────────────────

async function getIPLStandings() {
  const [regular, playoff] = await Promise.all([
    _fetch(`/standings/stage/${IPL_STAGE_ID}`,   { include: "team" }),
    _fetch(`/standings/stage/${IPL_PLAYOFF_ID}`,  { include: "team" }),
  ]);
  return { regular: regular ?? [], playoff: playoff ?? [] };
}

// ── Players ───────────────────────────────────────────────────

async function getPlayer(playerId) {
  return _fetch(`/players/${playerId}`);
}

async function searchPlayers(query, page = 1) {
  return _fetch("/players", {
    "filter[name]": query,
    per_page: 25,
    page,
  });
}

async function getPlayersList(page = 1) {
  return _fetch("/players", { per_page: 50, page });
}

// ── Rankings ──────────────────────────────────────────────────

async function getTeamRankings() {
  return _fetch("/team-rankings", { include: "team" });
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  IPL_LEAGUE_ID,
  IPL_SEASON_ID,
  IPL_STAGE_ID,
  getIPLFixtures,
  getFixtureDetail,
  getLivescores,
  getTeamSquad,
  getIPLStandings,
  getPlayer,
  searchPlayers,
  getPlayersList,
  getTeamRankings,
};
