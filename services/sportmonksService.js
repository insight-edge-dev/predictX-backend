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

/**
 * Like _fetch, but follows `meta.last_page` and concatenates `data` across
 * pages (capped at maxPages). Needed for generic international buckets —
 * e.g. a single T20I season can span 100+ fixtures across multiple pages,
 * unlike single-tournament leagues which always fit in one page.
 */
async function _fetchAllPages(endpoint, params = {}, maxPages = 3) {
  const key = _key();
  if (!key) {
    console.warn("[SM] SPORTMONKS_API_KEY not set");
    return [];
  }
  if (Date.now() < _rateLimitUntil) {
    return [];
  }

  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const { data } = await axios.get(`${BASE}${endpoint}`, {
        params:  { api_token: key, ...params, page },
        timeout: TIMEOUT_MS,
      });
      const pageData = data?.data;
      if (Array.isArray(pageData)) results.push(...pageData);

      const lastPage = data?.meta?.last_page ?? 1;
      if (page >= lastPage) break;
    } catch (e) {
      if (e.response?.status === 429) {
        _rateLimitUntil = Date.now() + 2 * 60_000;
        console.warn("[SM] 429 — backing off 2 min");
      } else {
        console.error(`[SM] ${endpoint} (page ${page}) error:`, e.response?.status ?? e.message);
      }
      break;
    }
  }
  return results;
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
 * Single fixture with full scorecard, lineup, officials, man of match.
 */
async function getFixtureDetail(fixtureId) {
  return _fetch(`/fixtures/${fixtureId}`, {
    include: "localteam,visitorteam,runs,batting.batsman,bowling.bowler,scoreboards,venue,lineup,manofmatch,firstumpire,secondumpire,tvumpire,tosswon",
  });
}

/**
 * All today's fixtures (live + scheduled today) — all leagues.
 */
async function getLivescores() {
  return _fetch("/livescores", {
    include: "localteam,visitorteam,runs,batting,bowling",
  });
}

/**
 * Fixtures updated in the last 2 hours — efficient incremental polling.
 * Use instead of full /livescores for WebSocket server-side refresh.
 */
async function getFixtureUpdates() {
  return _fetch("/fixtures/updates", {
    include: "localteam,visitorteam,runs",
  });
}

/**
 * Ball-by-ball delivery data for a match.
 * Returns balls[] with over, ball, runs, four, six, is_wicket, commentary.
 */
async function getMatchBalls(fixtureId) {
  return _fetch(`/fixtures/${fixtureId}`, {
    include: "balls,localteam,visitorteam,runs",
  });
}

/**
 * Single venue profile.
 */
async function getVenue(venueId) {
  return _fetch(`/venues/${venueId}`, { include: "country" });
}

/**
 * ICC team rankings filtered by format and gender.
 * type: 'TEST' | 'ODI' | 'T20I'
 * gender: 'men' | 'women'
 */
async function getTeamRankingsFiltered(type, gender) {
  return _fetch("/team-rankings", {
    "filter[tournament_type]": type,
    "filter[gender]":          gender,
    include:                   "team",
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
  return _fetch(`/players/${playerId}`, { include: "career" });
}

async function searchPlayers(query, page = 1) {
  return _fetch("/players", {
    "filter[name]": query,
    include:         "country,position",
    per_page:        25,
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

// ── All-leagues discovery ─────────────────────────────────────

/**
 * All leagues available in the subscription.
 * Returns array of { id, name, code, image_path, country }.
 * Season data is fetched separately via getRecentSeasons().
 */
async function getAllLeagues() {
  return _fetch("/leagues", {
    include:  "country",
    per_page: 100,
  });
}

/**
 * Recent seasons — sorted by id descending (newest first).
 * Used to find the current season for any league.
 */
async function getRecentSeasons() {
  return _fetch("/seasons", {
    sort:     "-id",
    per_page: 500,
  });
}

/**
 * Seasons for a specific league, newest first.
 * Reliable fallback when batch seasons don't include a league.
 */
async function getSeasonForLeague(leagueId) {
  const data = await _fetch("/seasons", {
    "filter[league_id]": leagueId,
    sort:                "-id",
    per_page:            5,
  });
  return Array.isArray(data) ? data[0] ?? null : null;
}

/**
 * All stages for a season (needed to find regular-season stage_id).
 */
async function getSeasonStages(seasonId) {
  return _fetch("/stages", {
    "filter[season_id]": seasonId,
    per_page: 50,
  });
}

// ── Season player stats (from fixtures) ──────────────────────

/**
 * All fixtures for a season with batting + bowling player data included.
 * Used to aggregate Orange Cap / Purple Cap / Six Hitters leaderboards.
 */
async function getSeasonFixturesWithStats(seasonId = IPL_SEASON_ID) {
  return _fetch("/fixtures", {
    "filter[season_id]": seasonId,
    include: "localteam,visitorteam,batting.batsman,bowling.bowler",
    per_page: 100,
  });
}

// ── Generic league queries ────────────────────────────────────

/**
 * All fixtures for any Sportsmonks season.
 * Used by leagueService for multi-league support.
 */
async function getFixturesBySeasonId(seasonId) {
  return _fetch("/fixtures", {
    "filter[season_id]": seasonId,
    include: "localteam,visitorteam,runs",
    per_page: 100,
  });
}

/**
 * All fixtures for a generic international bucket league + season
 * (e.g. "Twenty20 International", id 3) with venue + stage included —
 * `stage.name` is what carries the bilateral series name (e.g.
 * "New Zealand tour of India"), used by internationalService to group
 * fixtures into named tours. Paginated — these buckets span 100+ fixtures.
 */
async function getInternationalFixtures(seasonId) {
  return _fetchAllPages("/fixtures", {
    "filter[season_id]": seasonId,
    include:  "localteam,visitorteam,venue,stage,runs",
    per_page: 100,
  });
}

/**
 * All historical meetings between two teams within one league (both home/away
 * directions) — used to build an all-time head-to-head record for bilateral
 * international predictions (no shared league table to lean on there).
 */
async function getFixturesBetweenTeams(leagueId, teamAId, teamBId) {
  const common = { "filter[league_id]": leagueId, include: "localteam,visitorteam", per_page: 50, sort: "-starting_at" };
  const [ab, ba] = await Promise.all([
    _fetch("/fixtures", { ...common, "filter[localteam_id]": teamAId, "filter[visitorteam_id]": teamBId }),
    _fetch("/fixtures", { ...common, "filter[localteam_id]": teamBId, "filter[visitorteam_id]": teamAId }),
  ]);
  return [...(Array.isArray(ab) ? ab : []), ...(Array.isArray(ba) ? ba : [])];
}

/**
 * A team's most recent fixtures (any opponent) within one league — used to
 * derive "recent international form" for bilateral predictions.
 */
async function getTeamRecentFixtures(leagueId, teamId, perPage = 20) {
  const common = { "filter[league_id]": leagueId, include: "localteam,visitorteam", per_page: perPage, sort: "-starting_at" };
  const [asLocal, asVisitor] = await Promise.all([
    _fetch("/fixtures", { ...common, "filter[localteam_id]": teamId }),
    _fetch("/fixtures", { ...common, "filter[visitorteam_id]": teamId }),
  ]);
  return [...(Array.isArray(asLocal) ? asLocal : []), ...(Array.isArray(asVisitor) ? asVisitor : [])];
}

/**
 * Standings for any stage (regular + optional playoff).
 */
async function getStandingsByStageIds(stageId, playoffId) {
  const [regular, playoff] = await Promise.all([
    _fetch(`/standings/stage/${stageId}`,   { include: "team" }),
    playoffId ? _fetch(`/standings/stage/${playoffId}`, { include: "team" }) : Promise.resolve([]),
  ]);
  return { regular: regular ?? [], playoff: playoff ?? [] };
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  IPL_LEAGUE_ID,
  IPL_SEASON_ID,
  IPL_STAGE_ID,
  getIPLFixtures,
  getFixturesBySeasonId,
  getInternationalFixtures,
  getFixturesBetweenTeams,
  getTeamRecentFixtures,
  getStandingsByStageIds,
  getFixtureDetail,
  getLivescores,
  getFixtureUpdates,
  getMatchBalls,
  getVenue,
  getTeamRankingsFiltered,
  getTeamSquad,
  getIPLStandings,
  getAllLeagues,
  getRecentSeasons,
  getSeasonForLeague,
  getSeasonStages,
  getPlayer,
  searchPlayers,
  getPlayersList,
  getTeamRankings,
  getSeasonFixturesWithStats,
};
