/**
 * matchController.js — handlers for /api/matches/* routes.
 *
 * Data source: Highlightly API + hl_fixtures / hl_scorecards warehouse.
 *
 * Cache tiers:
 *   NodeCache (hot) → hl_scorecards Supabase (warm) → Highlightly API (cold)
 */

const hl  = require("../services/highlightlyService");
const storage = require("../services/highlightlyStorageService");
const hlSync  = require("../services/highlightlySyncService");
const db  = require("../services/dbService");
const {
  normalizeFixture,
  normalizeScorecard,
  normalizeFootballFixture,
} = require("../services/highlightlyNormalizer");
const {
  getIPLMatches,
  getIPLLiveMatches,
  getIPLFixtures,
} = require("../services/iplService");
const { getCache, setCache, TTL, KEYS } = require("../services/cacheService");
const supabase = require("../config/supabase");

// In-flight deduplication: concurrent requests for the same match ID share
// one Highlightly call instead of firing N parallel requests → avoids 429s.
const _fullFixtureInFlight = new Map();

// Converts the internal normalizeScorecard shape → Innings[] expected by the frontend.
// Internal: { innings: [{ inningIndex, team, batsmen[{playerId,...}], bowlers, extras:{total,wides,noBalls,...}, fallOfWickets }] }
// Frontend: [{ inning, batsmen[{id,...}], bowlers[{id,...}], extras:{runs,nb,wd,lb,b}, total:{runs,wickets,overs}, yetToBat, fow }]
function _toFrontendInnings(scorecard, match) {
  const rawInnings = Array.isArray(scorecard) ? scorecard : (scorecard?.innings ?? []);
  if (!rawInnings.length) return null;

  function parseScore(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d+)(?:\/(\d+))?/);
    return m ? { runs: parseInt(m[1], 10), wickets: parseInt(m[2] ?? "10", 10) } : null;
  }
  function parseOvers(s) {
    if (!s) return "";
    return String(s).replace(/,?\s*T:\d+\s*ov/i, "").replace(/\s*ov.*/i, "").trim();
  }

  return rawInnings.map(inn => {
    const team   = inn.team ?? {};
    const teamId = String(team.id || "");

    // Match this innings' team to the fixture's home/away scores by team ID.
    let sc       = null;
    let oversStr = "";
    if (match) {
      const isHome = teamId && teamId === String(match.team1?.id || "");
      const isAway = teamId && teamId === String(match.team2?.id || "");
      if (isHome) { sc = parseScore(match.score1); oversStr = parseOvers(match.overs1); }
      else if (isAway) { sc = parseScore(match.score2); oversStr = parseOvers(match.overs2); }
    }

    const batsmen = (inn.batsmen || []).map(b => ({
      id:         b.playerId || b.id || "",
      name:       b.name     || "",
      imageUrl:   b.imageUrl ?? null,
      runs:       b.runs       ?? 0,
      balls:      b.balls      ?? 0,
      fours:      b.fours      ?? 0,
      sixes:      b.sixes      ?? 0,
      strikeRate: b.strikeRate ?? 0,
      dismissal:  b.dismissalText || b.dismissal || "",
      isNotOut:   b.dismissal === "not out" || b.isNotOut === true,
      isCaptain:  b.isCaptain ?? false,
      isKeeper:   b.isKeeper  ?? false,
    }));

    const bowlers = (inn.bowlers || []).map(b => ({
      id:       b.playerId || b.id || "",
      name:     b.name     || "",
      imageUrl: b.imageUrl ?? null,
      overs:    b.overs    ?? 0,
      maidens:  b.maidens  ?? 0,
      runs:     b.runs     ?? 0,
      wickets:  b.wickets  ?? 0,
      economy:  b.economy  ?? 0,
    }));

    const rawExtras = inn.extras ?? {};
    const extras = {
      runs: rawExtras.total   ?? rawExtras.runs ?? 0,
      nb:   rawExtras.noBalls ?? rawExtras.nb   ?? 0,
      wd:   rawExtras.wides   ?? rawExtras.wd   ?? 0,
      lb:   rawExtras.legByes ?? rawExtras.lb   ?? 0,
      b:    rawExtras.byes    ?? rawExtras.b    ?? 0,
    };

    const fow = (inn.fallOfWickets || inn.fow || []).map(f => ({
      player: f.batsman || f.player || "",
      runs:   f.runs ?? 0,
      over:   String(f.over ?? f.overs ?? 0),
    }));

    const teamShort = team.shortName || team.abbreviation || team.name || "";
    return {
      inning:   `${teamShort} Innings`,
      batsmen,
      bowlers,
      extras,
      total:    sc ? { runs: sc.runs, wickets: sc.wickets, overs: oversStr } : null,
      yetToBat: inn.yetToBat ?? [],
      fow,
    };
  });
}

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
// Lightweight match summary — from hl_fixtures warehouse.

async function getMatchById(req, res) {
  const id = String(req.params.id);
  if (!id) return res.status(400).json({ error: "Match id required" });

  const cacheKey = KEYS.MATCH_DETAIL(id);
  try {
    // 1. NodeCache
    const mem = getCache(cacheKey);
    if (mem) return res.json(mem);

    // 2. IPL fixtures list first (likely already cached)
    const fixtures = await getIPLFixtures();
    const match    = fixtures.find(m => String(m.id) === id);
    if (match) {
      setCache(cacheKey, match, match.status === "live" ? TTL.LIVE : TTL.MATCH_DETAIL);
      return res.json(match);
    }

    // 3. Warehouse for non-IPL matches (league matches stored by syncService)
    const stored = await storage.getTodayFixtures(); // broad warehouse query fallback
    const wMatch = stored.find(m => String(m.id) === id);
    if (wMatch) {
      setCache(cacheKey, wMatch, wMatch.status === "live" ? TTL.LIVE : TTL.MATCH_DETAIL);
      return res.json(wMatch);
    }

    return res.status(404).json({ error: "Match not found" });
  } catch (e) {
    console.error(`[Match] getMatchById(${id}):`, e.message);
    return res.status(500).json({ error: "Failed to fetch match" });
  }
}

// ── Internal: resolve full fixture detail ─────────────────────
// NodeCache → hl_scorecards warehouse → Highlightly API.

async function _resolveFullFixture(id) {
  const sid = String(id);

  // Deduplicate: if a request for this ID is already in-flight, wait for it.
  if (_fullFixtureInFlight.has(sid)) {
    return _fullFixtureInFlight.get(sid);
  }
  const promise = _doResolveFullFixture(sid);
  _fullFixtureInFlight.set(sid, promise);
  promise.finally(() => _fullFixtureInFlight.delete(sid));
  return promise;
}

async function _doResolveFullFixture(sid) {
  const cacheKey = KEYS.MATCH_FULL(sid);

  // 1. NodeCache
  const mem = getCache(cacheKey);
  if (mem) return { data: mem, fresh: false };

  // 2. Check hl_fixtures to detect sport — football matches skip the cricket path
  try {
    const { data: row } = await supabase
      .from("hl_fixtures")
      .select("format, data")
      .eq("id", sid)
      .maybeSingle();

    if (row?.format === "90min") {
      // Football match — try to enrich with live detail, fall back to stored data
      let full = row.data ?? null;
      try {
        const raw = await hl.getFootballMatchDetail(sid);
        if (raw) {
          const enriched = normalizeFootballFixture(raw);
          if (enriched) full = enriched;
        }
      } catch {}
      if (full) {
        setCache(cacheKey, full, full.status === "live" ? TTL.LIVE : TTL.MATCH_DETAIL);
        return { data: full, fresh: true };
      }
    }
  } catch {}

  // 3. Warehouse scorecard (permanent store — set after first API call)
  const storedSc = await storage.getScorecard(sid);
  if (storedSc) {
    // Look up fixture header from hl_fixtures (Highlightly IDs — works for all leagues).
    // getIPLFixtures() uses Sportsmonks IDs which never match Highlightly match IDs.
    let match = null;
    try {
      const { data: fr } = await supabase
        .from("hl_fixtures")
        .select("data")
        .eq("id", sid)
        .maybeSingle();
      if (fr?.data) match = fr.data;
    } catch {}

    if (match) {
      const scorecard = _toFrontendInnings(storedSc, match);
      const full = { ...match, scorecard, squad: _buildSquadFromScorecard(storedSc, match) };
      setCache(cacheKey, full, TTL.MATCH_DETAIL);
      return { data: full, fresh: false };
    }
  }

  // 4. Highlightly API — fetch full cricket match detail
  let raw = null;
  try {
    raw = await hl.getMatchDetail(sid);
  } catch (e) {
    console.warn(`[Match] hl.getMatchDetail(${sid}) failed:`, e.message);
  }

  if (!raw) {
    // 4a. IPL list fallback
    const fixtures = await getIPLFixtures();
    const basic    = fixtures.find(m => String(m.id) === sid);
    if (basic) return { data: basic, fresh: false };

    // 4b. hl_fixtures warehouse fallback — covers non-IPL leagues (Sri Lanka, etc.)
    // that are synced but not in the IPL list and whose detail Highlightly can't serve
    try {
      const { data: warehouseRow } = await supabase
        .from("hl_fixtures")
        .select("data")
        .eq("id", sid)
        .maybeSingle();
      if (warehouseRow?.data) return { data: warehouseRow.data, fresh: false };
    } catch (e) {
      console.warn(`[Match] warehouse fallback(${sid}) failed:`, e.message);
    }

    return { data: null, fresh: false };
  }

  // normalizeFixture works on the match-detail object too (same shape as list items)
  const match        = normalizeFixture(raw) ?? getCache(`match:basic:${sid}`) ?? null;
  const scorecardRaw = normalizeScorecard(raw, sid);          // internal format (stored in warehouse)
  const scorecard    = _toFrontendInnings(scorecardRaw, match); // Innings[] for the frontend
  const squad        = scorecardRaw ? _buildSquadFromScorecard(scorecardRaw, match) : { team1Players: [], team2Players: [] };

  const full = { ...(match ?? {}), scorecard, squad };

  // Persist scorecard permanently (store internal format so _toFrontendInnings can re-transform on cache miss)
  if (scorecardRaw) {
    void storage.storeScorecard(sid, scorecardRaw);
  }

  const ttl = match?.status === "live" ? TTL.LIVE : TTL.MATCH_DETAIL;
  setCache(cacheKey, full, ttl);
  return { data: full, fresh: true };
}

// Build squad from scorecard innings (batsmen + bowlers who played)
function _buildSquadFromScorecard(scorecard, match) {
  if (!scorecard?.innings?.length) {
    return {
      team1: { name: match?.team1?.name ?? "", shortName: match?.team1?.shortName ?? "" },
      team2: { name: match?.team2?.name ?? "", shortName: match?.team2?.shortName ?? "" },
      team1Players: [], team2Players: [],
    };
  }

  const playerMap1 = new Map();
  const playerMap2 = new Map();
  const t1Name = match?.team1?.name ?? "";
  const t2Name = match?.team2?.name ?? "";

  for (const inn of scorecard.innings) {
    const isT1 = inn.team?.name === t1Name || (inn.inningIndex === 1);
    const targetMap = isT1 ? playerMap1 : playerMap2;

    for (const b of (inn.batsmen || [])) {
      if (!b.playerId) continue;
      targetMap.set(b.playerId, {
        id:           b.playerId,
        name:         b.name,
        role:         (b.roles?.[0] ?? ""),
        battingStyle: b.battingStyle ?? "",
        bowlingStyle: "",
        image:        "",
        isCaptain:    false,
        isKeeper:     b.roles?.some(r => /keep/i.test(r)) ?? false,
      });
    }
    for (const b of (inn.bowlers || [])) {
      if (!b.playerId) continue;
      const existing = targetMap.get(b.playerId);
      if (existing) existing.bowlingStyle = b.bowlingStyle ?? "";
      else targetMap.set(b.playerId, {
        id:           b.playerId,
        name:         b.name,
        role:         "Bowler",
        battingStyle: "",
        bowlingStyle: b.bowlingStyle ?? "",
        image:        "",
        isCaptain:    false,
        isKeeper:     false,
      });
    }
  }

  return {
    team1: { name: t1Name, shortName: match?.team1?.shortName ?? "" },
    team2: { name: t2Name, shortName: match?.team2?.shortName ?? "" },
    team1Players: [...playerMap1.values()],
    team2Players: [...playerMap2.values()],
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

    // 3. Get fixture info — check IPL list first, then warehouse
    const fixtures = await getIPLFixtures();
    let match = fixtures.find(m => String(m.id) === String(id));
    if (!match) {
      const all = await storage.getTodayFixtures();
      match = all.find(m => String(m.id) === String(id)) ?? null;
    }
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

    // For upcoming: no squad data available from Highlightly yet
    const emptySquad = {
      team1: { name: match?.team1?.name ?? "", shortName: match?.team1?.shortName ?? "" },
      team2: { name: match?.team2?.name ?? "", shortName: match?.team2?.shortName ?? "" },
      team1Players: [],
      team2Players: [],
    };
    setCache(cacheKey, emptySquad, TTL.MATCH_DETAIL);
    return res.json(emptySquad);
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

// ── GET /api/matches/:id/lineup ───────────────────────────────
// Derive lineup from scorecard (players who batted/bowled in the match).

async function getMatchLineup(req, res) {
  const { id } = req.params;
  const cacheKey = `match:lineup:${id}`;

  const mem = getCache(cacheKey);
  if (mem) return res.json(mem);

  try {
    const { data } = await _resolveFullFixture(id);
    if (!data?.squad) return res.json({ team1XI: [], team2XI: [] });

    const lineup = {
      team1XI: data.squad.team1Players ?? [],
      team2XI: data.squad.team2Players ?? [],
    };
    if (lineup.team1XI.length || lineup.team2XI.length) {
      setCache(cacheKey, lineup, TTL.DAILY);
    }
    return res.json(lineup);
  } catch (e) {
    console.error("[Match] lineup error:", e.message);
    return res.json({ team1XI: [], team2XI: [] });
  }
}

// ── GET /api/matches/:id/overs ────────────────────────────────
// Ball-by-ball data is not available from Highlightly — return empty.

async function getMatchOvers(req, res) {
  return res.json({ overs: [], currentOver: 0 });
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
  getMatchLineup,
  getMatchOvers,
};
