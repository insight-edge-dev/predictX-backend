/**
 * homeRoutes.js
 *
 * GET /api/home/rankings  — ICC T20 team rankings (Sportsmonks)
 *                           + batsmen/bowlers fallback from Cricbuzz
 * GET /api/home/news      — cricket news (Cricbuzz)
 * GET /api/home/news/:id  — full article (Cricbuzz)
 * GET /api/img/news/:id   — proxied Cricbuzz image
 */

const express  = require("express");
const axios    = require("axios");
const sm       = require("../services/sportmonksService");
const { fetchCricketNews }  = require("../services/newsService");
const { getCache, setCache } = require("../services/cacheService");
const { getCachedData, setCachedData } = require("../services/dbService");

const router = express.Router();

const CRICBUZZ_HOST = "cricbuzz-cricket.p.rapidapi.com";
const RANKINGS_TTL_S  = 48 * 60 * 60;      // 48h — preserve Cricbuzz quota
const RANKINGS_TTL_MS = RANKINGS_TTL_S * 1000;
const DB_RANKINGS_KEY = "home:rankings:v4"; // v4: Cricbuzz team rankings

function cricbuzzHeaders() {
  return {
    "x-rapidapi-host": CRICBUZZ_HOST,
    "x-rapidapi-key":  process.env.CRICBUZZ_API_KEY,
  };
}

// Strip Cricbuzz inline format markers like @B0$, @L3$
function cleanText(text) {
  return (text || "").replace(/@[A-Z]\d+\$/g, "").trim();
}

// ── GET /api/home/rankings ────────────────────────────────────

router.get("/home/rankings", async (_req, res) => {
  try {
    // 1. NodeCache
    const mem = getCache(DB_RANKINGS_KEY);
    if (mem) return res.json(mem);

    // 2. DB cache (6 h)
    const dbHit = await getCachedData(DB_RANKINGS_KEY, RANKINGS_TTL_MS);
    if (dbHit) {
      setCache(DB_RANKINGS_KEY, dbHit, RANKINGS_TTL_S);
      return res.json(dbHit);
    }

    // 3. Cricbuzz — team + player rankings (one API call set, cached 48h)
    let batsmen = [], bowlers = [], t20Teams = [], odiTeams = [], testTeams = [];

    if (process.env.CRICBUZZ_API_KEY) {
      const calls = [
        axios.get(`https://${CRICBUZZ_HOST}/stats/v1/rankings/batsmen`,  { headers: cricbuzzHeaders(), params: { formatType: "t20"  }, timeout: 10000 }),
        axios.get(`https://${CRICBUZZ_HOST}/stats/v1/rankings/bowlers`,  { headers: cricbuzzHeaders(), params: { formatType: "t20"  }, timeout: 10000 }),
        axios.get(`https://${CRICBUZZ_HOST}/stats/v1/rankings/teams`,    { headers: cricbuzzHeaders(), params: { formatType: "t20"  }, timeout: 10000 }),
        axios.get(`https://${CRICBUZZ_HOST}/stats/v1/rankings/teams`,    { headers: cricbuzzHeaders(), params: { formatType: "odi"  }, timeout: 10000 }),
        axios.get(`https://${CRICBUZZ_HOST}/stats/v1/rankings/teams`,    { headers: cricbuzzHeaders(), params: { formatType: "test" }, timeout: 10000 }),
      ];

      const results = await Promise.allSettled(calls);

      function mapPlayer(r) {
        return {
          id:      String(r.id),
          rank:    Number(r.rank),
          name:    r.name,
          country: r.country,
          rating:  Number(r.rating),
          points:  Number(r.points),
          trend:   r.trend || "Flat",
          imageUrl: r.faceImageId
            ? `https://cricbuzz-static.s3.amazonaws.com/media/img/oneline/${r.faceImageId}.jpg`
            : null,
        };
      }

      function mapTeam(r, idx) {
        return {
          id:      String(r.id || idx),
          rank:    Number(r.rank || idx + 1),
          name:    r.name || "",
          code:    r.teamId || "",
          image:   r.imageId ? `https://cricbuzz-static.s3.amazonaws.com/img/team/${r.imageId}.jpg` : "",
          rating:  Number(r.rating || 0),
          matches: 0,
          points:  Number(r.points || 0),
        };
      }

      if (results[0].status === "fulfilled") batsmen  = (results[0].value.data?.rank ?? []).slice(0,10).map(mapPlayer);
      if (results[1].status === "fulfilled") bowlers   = (results[1].value.data?.rank ?? []).slice(0,10).map(mapPlayer);
      if (results[2].status === "fulfilled") t20Teams  = (results[2].value.data?.rank ?? []).slice(0,16).map(mapTeam);
      if (results[3].status === "fulfilled") odiTeams  = (results[3].value.data?.rank ?? []).slice(0,16).map(mapTeam);
      if (results[4].status === "fulfilled") testTeams = (results[4].value.data?.rank ?? []).slice(0,16).map(mapTeam);

      const failed = results.filter(r => r.status === "rejected").length;
      console.log(`[Rankings] Cricbuzz: ${results.length - failed}/${results.length} succeeded. T20 teams: ${t20Teams.length}, batsmen: ${batsmen.length}`);
    }

    const result = {
      batsmen,
      bowlers,
      teams: t20Teams, // backwards compat for legacy home widget
      rankings: {
        t20i_men:   t20Teams,
        odi_men:    odiTeams,
        test_men:   testTeams,
        t20i_women: [],
        odi_women:  [],
      },
    };

    // Cache for 48h IF we got any data — preserve Cricbuzz quota
    const hasData = batsmen.length > 0 || t20Teams.length > 0;
    if (hasData) {
      await setCachedData(DB_RANKINGS_KEY, result);
      setCache(DB_RANKINGS_KEY, result, RANKINGS_TTL_S);
      console.log("[Rankings] cached for 48h");
    } else {
      console.warn("[Rankings] no data returned — not caching (will retry next request)");
    }
    return res.json(result);
  } catch (e) {
    console.error("[Home] rankings error:", e.message);
    return res.status(500).json({ batsmen: [], bowlers: [], teams: [] });
  }
});

// ── GET /api/home/news ────────────────────────────────────────

router.get("/home/news", async (_req, res) => {
  try {
    return res.json(await fetchCricketNews());
  } catch (e) {
    console.error("[Home] news error:", e.message);
    return res.status(500).json([]);
  }
});

// ── GET /api/home/news/:id ────────────────────────────────────

router.get("/home/news/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid id" });

  const cacheKey = `news:detail:${id}`;
  const mem = getCache(cacheKey);
  if (mem) return res.json(mem);

  const dbHit = await getCachedData(cacheKey, 24 * 60 * 60_000);
  if (dbHit) { setCache(cacheKey, dbHit, 24 * 60 * 60); return res.json(dbHit); }

  try {
    const { data } = await axios.get(
      `https://${CRICBUZZ_HOST}/news/v1/detail/${id}`,
      { headers: cricbuzzHeaders(), timeout: 10_000 },
    );
    const paragraphs = (data.content || [])
      .filter(item => item.content?.contentType === "text")
      .map(item => cleanText(item.content.contentValue))
      .filter(Boolean);

    const article = {
      id:          data.id,
      headline:    data.headline || "",
      context:     data.context  || "",
      publishTime: data.publishTime ? Number(data.publishTime) : null,
      coverImage:  data.coverImage  || null,
      paragraphs,
    };

    await setCachedData(cacheKey, article);
    setCache(cacheKey, article, 24 * 60 * 60);
    return res.json(article);
  } catch (e) {
    console.error(`[Home] news detail ${id}:`, e.message);
    return res.status(500).json({ error: "Failed to fetch article" });
  }
});

// ── GET /api/home/season-stats ────────────────────────────────
// Aggregates Orange Cap / Purple Cap / Six Hitters from season fixtures.
// Uses Sportsmonks /fixtures with batting.batsman + bowling.bowler includes.

const SEASON_STATS_TTL_S  = 30 * 60;
const SEASON_STATS_TTL_MS = SEASON_STATS_TTL_S * 1000;

const COMPLETED_STATUSES = new Set(["Finished", "Completed", "Abandoned", "Rained Out", "No Result"]);

function _isCompleted(f) {
  return COMPLETED_STATUSES.has(f.status) || !!f.draw_noresult;
}

function _playerFullName(p) {
  if (!p) return "";
  return [p.firstname, p.lastname].filter(Boolean).join(" ");
}

function _aggregateBatting(fixtures) {
  const map = new Map();
  for (const f of fixtures) {
    if (!_isCompleted(f) || !Array.isArray(f.batting)) continue;
    for (const b of f.batting) {
      if (!b.player_id || b.score == null) continue;
      const pid  = String(b.player_id);
      const name = _playerFullName(b.batsman);
      if (!name) continue;
      if (!map.has(pid)) {
        const teamId = b.team_id;
        const team   = f.localteam_id === teamId ? f.localteam : f.visitorteam;
        map.set(pid, { playerId: pid, name, imageUrl: b.batsman?.image_path ?? null, teamShort: team?.code ?? "", teamName: team?.name ?? "", runs: 0, sixes: 0, fixtures: new Set() });
      }
      const p = map.get(pid);
      p.runs  += Number(b.score)  || 0;
      p.sixes += Number(b.six_x)  || 0;
      p.fixtures.add(f.id);
    }
  }
  return Array.from(map.values()).map(p => ({ ...p, matches: p.fixtures.size, fixtures: undefined }));
}

function _aggregateBowling(fixtures) {
  const map = new Map();
  for (const f of fixtures) {
    if (!_isCompleted(f) || !Array.isArray(f.bowling)) continue;
    for (const b of f.bowling) {
      if (!b.player_id || b.wickets == null) continue;
      const pid  = String(b.player_id);
      const name = _playerFullName(b.bowler);
      if (!name) continue;
      if (!map.has(pid)) {
        const teamId = b.team_id;
        const team   = f.localteam_id === teamId ? f.localteam : f.visitorteam;
        map.set(pid, { playerId: pid, name, imageUrl: b.bowler?.image_path ?? null, teamShort: team?.code ?? "", teamName: team?.name ?? "", wickets: 0, fixtures: new Set() });
      }
      const p = map.get(pid);
      p.wickets += Number(b.wickets) || 0;
      p.fixtures.add(f.id);
    }
  }
  return Array.from(map.values()).map(p => ({ ...p, matches: p.fixtures.size, fixtures: undefined }));
}

router.get("/home/season-stats", async (_req, res) => {
  const cacheKey = `home:season-stats:sm:${sm.IPL_SEASON_ID}`;
  try {
    const mem = getCache(cacheKey);
    if (mem) return res.json(mem);

    const dbHit = await getCachedData(cacheKey, SEASON_STATS_TTL_MS);
    if (dbHit) {
      setCache(cacheKey, dbHit, SEASON_STATS_TTL_S);
      return res.json(dbHit);
    }

    const fixtures = await sm.getSeasonFixturesWithStats();
    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      console.warn("[SeasonStats] No fixtures returned from Sportsmonks");
      return res.json({ orangeCap: [], purpleCap: [], sixHitters: [] });
    }

    console.log(`[SeasonStats] Aggregating from ${fixtures.length} fixtures`);

    const batting  = _aggregateBatting(fixtures);
    const bowling  = _aggregateBowling(fixtures);

    const result = {
      orangeCap:  batting.sort((a, b) => b.runs - a.runs).slice(0, 8)
        .map(p => ({ ...p, runs: p.runs, wickets: null, sixes: null })),
      purpleCap:  bowling.sort((a, b) => b.wickets - a.wickets).slice(0, 8)
        .map(p => ({ ...p, runs: null, sixes: null })),
      sixHitters: [...batting].sort((a, b) => b.sixes - a.sixes).slice(0, 8)
        .map(p => ({ ...p, runs: null, wickets: null, sixes: p.sixes })),
    };

    console.log(`[SeasonStats] orangeCap:${result.orangeCap.length} purpleCap:${result.purpleCap.length} sixHitters:${result.sixHitters.length}`);

    if (result.orangeCap.length > 0 || result.purpleCap.length > 0) {
      await setCachedData(cacheKey, result);
      setCache(cacheKey, result, SEASON_STATS_TTL_S);
    }
    return res.json(result);
  } catch (e) {
    console.error("[Home] season-stats error:", e.message);
    return res.status(500).json({ orangeCap: [], purpleCap: [], sixHitters: [] });
  }
});

// ── GET /api/img/news/:imageId ────────────────────────────────

router.get("/img/news/:imageId", async (req, res) => {
  const { imageId } = req.params;
  if (!/^\d+$/.test(imageId)) return res.status(400).end();

  // Serve from memory cache if available (avoids repeat Cricbuzz API calls)
  const cacheKey = `img:news:${imageId}`;
  const cached = getCache(cacheKey);
  if (cached) {
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(cached);
  }

  try {
    // Try i2 (medium) first, fall back to i1 (small thumbnail)
    let response;
    try {
      response = await axios.get(
        `https://cricbuzz-cricket.p.rapidapi.com/img/v1/i2/c${imageId}/i.jpg`,
        { headers: cricbuzzHeaders(), responseType: "arraybuffer", timeout: 8_000 },
      );
    } catch {
      response = await axios.get(
        `https://cricbuzz-cricket.p.rapidapi.com/img/v1/i1/c${imageId}/i.jpg`,
        { headers: cricbuzzHeaders(), responseType: "arraybuffer", timeout: 8_000 },
      );
    }
    const buf = Buffer.from(response.data);
    setCache(cacheKey, buf, 24 * 60 * 60);
    res.set("Content-Type", response.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch {
    res.status(404).end();
  }
});

module.exports = router;
