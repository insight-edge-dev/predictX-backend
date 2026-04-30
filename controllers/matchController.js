/**
 * matchController.js — handlers for /api/matches/* routes.
 *
 * Data source: Sportsmonks (single API, no quota issues).
 *
 * Cache tiers:
 *   NodeCache (hot) → Supabase DB (warm) → Sportsmonks API (cold)
 *
 * Match IDs are now Sportsmonks integer fixture IDs (e.g. 69518).
 */

const sm  = require("../services/sportmonksService");
const db  = require("../services/dbService");
const {
  normalizeFixture,
  normalizeScorecard,
  normalizeSquadPlayers,
} = require("../services/sportmonksNormalizer");
const {
  getIPLMatches,
  getIPLLiveMatches,
  getIPLFixtures,
} = require("../services/iplService");
const { getCache, setCache, TTL, KEYS } = require("../services/cacheService");

// ── GET /api/matches ──────────────────────────────────────────

async function getMatches(req, res) {
  try {
    return res.json(await getIPLMatches());
  } catch (e) {
    console.error("[Match] getMatches:", e.message);
    return res.status(500).json({ live: [], upcoming: [], completed: [] });
  }
}

// ── GET /api/matches/live ─────────────────────────────────────

async function getLive(req, res) {
  try {
    return res.json({ live: await getIPLLiveMatches() });
  } catch (e) {
    return res.status(500).json({ live: [] });
  }
}

// ── GET /api/matches/upcoming ─────────────────────────────────

async function getUpcoming(req, res) {
  try {
    const { upcoming } = await getIPLMatches();
    return res.json({ upcoming });
  } catch (e) {
    return res.status(500).json({ upcoming: [] });
  }
}

// ── GET /api/matches/results ──────────────────────────────────

async function getResults(req, res) {
  try {
    const { completed } = await getIPLMatches();
    return res.json({ completed });
  } catch (e) {
    return res.status(500).json({ completed: [] });
  }
}

// ── GET /api/matches/:id ──────────────────────────────────────
// Lightweight match summary — from fixtures list (no extra API call).

async function getMatchById(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Match id required" });

  const cacheKey = KEYS.MATCH_DETAIL(id);
  try {
    // 1. NodeCache
    const mem = getCache(cacheKey);
    if (mem) return res.json(mem);

    // 2. DB (completed matches only)
    const fromDB = await db.getMatch(String(id));
    if (fromDB) {
      setCache(cacheKey, fromDB, TTL.MATCH_DETAIL);
      return res.json(fromDB);
    }

    // 3. Fixtures list (cheap — already cached)
    const fixtures = await getIPLFixtures();
    const match    = fixtures.find(m => m.id === id);
    if (!match) return res.status(404).json({ error: "Match not found" });

    if (match.status === "completed") void db.saveMatch(String(id), match.status, match);
    setCache(cacheKey, match, match.status === "live" ? TTL.LIVE : TTL.MATCH_DETAIL);
    return res.json(match);
  } catch (e) {
    console.error(`[Match] getMatchById(${id}):`, e.message);
    return res.status(500).json({ error: "Failed to fetch match" });
  }
}

// ── Internal: resolve full fixture detail ─────────────────────
// NodeCache → DB → Sportsmonks API (with batting/bowling/scorecard).

async function _resolveFullFixture(id) {
  const cacheKey = KEYS.MATCH_FULL(id);

  // 1. NodeCache
  const mem = getCache(cacheKey);
  if (mem) return { data: mem, fresh: false };

  // 2. DB (completed matches)
  const fromDB = await db.getMatch(String(id));
  if (fromDB?.scorecard) {
    setCache(cacheKey, fromDB, TTL.MATCH_DETAIL);
    return { data: fromDB, fresh: false };
  }

  // 3. Sportsmonks — single call returns everything
  const raw = await sm.getFixtureDetail(id);
  if (!raw) return { data: null, fresh: false };

  const match     = normalizeFixture(raw);
  if (!match) return { data: null, fresh: false };

  const scorecard = normalizeScorecard(raw);

  // Squad from batting/bowling players (who actually played).
  // For upcoming matches (no batting data yet), fetch full team squads from Sportsmonks.
  let squad = _buildSquadFromFixture(raw, match);

  if (match.status === "upcoming" && !squad.team1Players.length && !squad.team2Players.length) {
    try {
      const [sq1, sq2] = await Promise.all([
        sm.getTeamSquad(raw.localteam_id),
        sm.getTeamSquad(raw.visitorteam_id),
      ]);
      squad = {
        team1: { name: match.team1.name, shortName: match.team1.shortName },
        team2: { name: match.team2.name, shortName: match.team2.shortName },
        team1Players: normalizeSquadPlayers(sq1 ?? []),
        team2Players: normalizeSquadPlayers(sq2 ?? []),
      };
    } catch (e) {
      console.warn("[Match] squad fetch for upcoming failed:", e.message);
    }
  }

  const full = { ...match, scorecard, squad };

  // Persist completed matches indefinitely
  if (match.status === "completed") {
    void db.saveMatch(String(id), match.status, full);
    if (squad?.team1Players?.length || squad?.team2Players?.length) {
      void db.saveSquad(String(id), squad);
    }
  }

  const ttl = match.status === "live" ? TTL.LIVE : TTL.MATCH_DETAIL;
  setCache(cacheKey, full, ttl);

  return { data: full, fresh: true };
}

// Build squad from players who appeared in batting/bowling entries
function _buildSquadFromFixture(raw, match) {
  const batting  = Array.isArray(raw.batting)  ? raw.batting  : [];
  const bowling  = Array.isArray(raw.bowling)  ? raw.bowling  : [];

  const playerMap = {};
  for (const b of batting)  { if (b.batsman) playerMap[b.player_id] = { ...b.batsman, team_id: b.team_id }; }
  for (const b of bowling)  { if (b.bowler)  playerMap[b.player_id] = { ...b.bowler,  team_id: b.team_id }; }

  const team1Players = [];
  const team2Players = [];

  for (const [, p] of Object.entries(playerMap)) {
    const player = {
      id:   String(p.id),
      name: p.fullname || `${p.firstname || ""} ${p.lastname || ""}`.trim(),
      role: p.position?.name || "",
      battingStyle: p.battingstyle || "",
      bowlingStyle: p.bowlingstyle || "",
      image: p.image_path || "",
      isCaptain: false,
      isKeeper:  p.position?.name === "Wicketkeeper",
    };
    if (p.team_id === raw.localteam_id)   team1Players.push(player);
    else                                   team2Players.push(player);
  }

  return {
    team1: { name: match.team1.name, shortName: match.team1.shortName },
    team2: { name: match.team2.name, shortName: match.team2.shortName },
    team1Players,
    team2Players,
  };
}

// ── GET /api/matches/:id/full ─────────────────────────────────

async function getMatchFull(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Match id required" });

  try {
    const { data } = await _resolveFullFixture(id);
    if (!data) return res.status(404).json({ error: "Match not found" });
    return res.json(data);
  } catch (e) {
    console.error(`[Match] getMatchFull(${id}):`, e.message);
    return res.status(500).json({ error: "Failed to fetch full match data" });
  }
}

// ── GET /api/matches/:id/scorecard ────────────────────────────

async function getMatchScorecard(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Match id required" });

  try {
    // Check full cache first (avoids re-fetching)
    const cached = getCache(KEYS.MATCH_FULL(id));
    if (cached) return res.json({ scorecard: cached.scorecard ?? null });

    const { data } = await _resolveFullFixture(id);
    if (!data) return res.status(404).json({ error: "Match not found" });
    return res.json({ scorecard: data.scorecard ?? null });
  } catch (e) {
    console.error(`[Match] getMatchScorecard(${id}):`, e.message);
    return res.status(500).json({ scorecard: null });
  }
}

// ── GET /api/matches/:id/squad ────────────────────────────────
// Returns the squad for both teams. For completed matches this comes from
// the fixture batting/bowling entries (who actually played).
// For upcoming matches it fetches from team squad endpoint.

async function getMatchSquad(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Match id required" });

  const cacheKey = KEYS.MATCH_SQUAD(id);
  try {
    // 1. NodeCache
    const mem = getCache(cacheKey);
    if (mem) return res.json(mem);

    // 2. DB
    const fromDB = await db.getSquad(String(id));
    if (fromDB) {
      setCache(cacheKey, fromDB, TTL.SQUADS);
      return res.json(fromDB);
    }

    // 3. Get fixture info to find team IDs
    const fixtures = await getIPLFixtures();
    const match    = fixtures.find(m => m.id === id);
    if (!match) return res.status(404).json({ error: "Match not found" });

    // For completed/live: extract from full fixture (plays actual players)
    if (match.status === "completed" || match.status === "live") {
      const { data } = await _resolveFullFixture(id);
      if (data?.squad) {
        void db.saveSquad(String(id), data.squad);
        setCache(cacheKey, data.squad, TTL.SQUADS);
        return res.json(data.squad);
      }
    }

    // For upcoming: fetch full season squads from both teams in parallel
    const raw = await sm.getFixtureDetail(id);
    if (!raw) return res.status(404).json({ error: "Squad not available" });

    const [sq1, sq2] = await Promise.all([
      sm.getTeamSquad(raw.localteam_id),
      sm.getTeamSquad(raw.visitorteam_id),
    ]);

    const squad = {
      team1: { name: match.team1.name, shortName: match.team1.shortName },
      team2: { name: match.team2.name, shortName: match.team2.shortName },
      team1Players: normalizeSquadPlayers(sq1 ?? []),
      team2Players: normalizeSquadPlayers(sq2 ?? []),
    };

    void db.saveSquad(String(id), squad);
    setCache(cacheKey, squad, TTL.SQUADS);
    return res.json(squad);
  } catch (e) {
    console.error(`[Match] getMatchSquad(${id}):`, e.message);
    return res.status(500).json({ team1Players: [], team2Players: [] });
  }
}

// ── GET /api/matches/:id/series ───────────────────────────────

async function getMatchSeries(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Match id required" });

  try {
    const fixtures = await getIPLFixtures();
    const { completed } = await getIPLMatches();
    const match = fixtures.find(m => m.id === id);
    if (!match) return res.status(404).json({ error: "Match not found" });

    return res.json({
      series:  { id: match.seriesId, name: match.series },
      matches: fixtures,
    });
  } catch (e) {
    console.error(`[Match] getMatchSeries(${id}):`, e.message);
    return res.status(500).json({ error: "Failed to fetch series" });
  }
}

// ── GET /api/matches/:id/stats ────────────────────────────────
// Alias for full match (scorecard contains all stats).

async function getMatchStats(req, res) {
  return getMatchFull(req, res);
}

module.exports = {
  getMatches,
  getLive,
  getUpcoming,
  getResults,
  getMatchById,
  getMatchSquad,
  getMatchFull,
  getMatchScorecard,
  getMatchSeries,
  getMatchStats,
};
