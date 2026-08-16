/**
 * homeRoutes.js
 *
 * GET /api/home/rankings  — ICC T20 team rankings (Sportsmonks)
 *                           + batsmen/bowlers fallback from Cricbuzz
 * GET /api/home/news      — cricket news (Cricbuzz)
 * GET /api/home/news/:id  — full article (Cricbuzz)
 * GET /api/img/news/:id   — proxied Cricbuzz image
 * GET /api/home/facts     — admin-editable "Did You Know?" facts
 * GET /api/home/sections  — admin-configured Discovery section order/visibility
 */

const express  = require("express");
const axios    = require("axios");
const { fetchCricketNews }  = require("../services/newsService");
const { getCache, setCache, TTL } = require("../services/cacheService");
const { getCachedData, setCachedData } = require("../services/dbService");
const accuracyService       = require("../services/accuracyService");
const leagueService         = require("../services/leagueService");
const footballService       = require("../services/footballService");
const internationalService  = require("../services/internationalService");
const predSvc               = require("../services/userPredictionService");
const { LEAGUES }           = require("../config/leaguesConfig");
const supabase = require("../config/supabase");

const router = express.Router();

const CRICBUZZ_HOST = "cricbuzz-cricket.p.rapidapi.com";
const RANKINGS_TTL_S  = 48 * 60 * 60;      // 48h — preserve Cricbuzz quota
const RANKINGS_TTL_MS = RANKINGS_TTL_S * 1000;
const DB_RANKINGS_KEY = "home:rankings:v5"; // v5: player faceImageId fix

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
        // faceImageId can be 0 (falsy) even when present — use strict null/undefined check
        const faceId = (r.faceImageId != null && r.faceImageId !== 0)
          ? r.faceImageId
          : (r.imageId != null && r.imageId !== 0 ? r.imageId : null);
        return {
          id:      String(r.id),
          rank:    Number(r.rank),
          name:    r.name,
          country: r.country,
          rating:  Number(r.rating),
          points:  Number(r.points),
          trend:   r.trend || "Flat",
          imageUrl: faceId
            ? `https://cricbuzz-static.s3.amazonaws.com/media/img/oneline/${faceId}.jpg`
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

      if (results[0].status === "fulfilled") {
        const raw = results[0].value.data?.rank ?? [];
        if (raw[0]) console.log("[Rankings] batsman sample fields:", Object.keys(raw[0]), "faceImageId=", raw[0].faceImageId, "imageId=", raw[0].imageId);
        batsmen = raw.slice(0, 10).map(mapPlayer);
      }
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
    res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
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

router.get("/home/season-stats", async (_req, res) => {
  // Orange/Purple Cap from stored hl_scorecards (Sportsmonks no longer available).
  // Aggregation from warehouse is a future enhancement; return empty for now.
  return res.json({ orangeCap: [], purpleCap: [], sixHitters: [] });
});

// ── GET /api/img/news/:imageId ────────────────────────────────
// Kept for backward compat (older cached API responses still point here).
// New responses use the public CDN URL directly — no Node buffer needed.

router.get("/img/news/:imageId", (req, res) => {
  const { imageId } = req.params;
  if (!/^\d+$/.test(imageId)) return res.status(400).end();
  res.redirect(302, `https://static.cricbuzz.com/a/img/v1/i2/c${imageId}/i.jpg`);
});

// ── GET /api/home/facts ───────────────────────────────────────
// Admin-editable "Did You Know?" facts for Discovery, sport-segmented.

router.get("/home/facts", async (req, res) => {
  const sport = req.query.sport === "football" ? "football" : "cricket";
  const cacheKey = `home:facts:${sport}`;
  try {
    const mem = getCache(cacheKey);
    if (mem) return res.json(mem);

    const { data, error } = await supabase
      .from("home_facts")
      .select("*")
      .eq("sport", sport)
      .eq("is_active", true)
      .order("display_order", { ascending: true });

    if (error) throw new Error(error.message);

    const facts = data ?? [];
    setCache(cacheKey, facts, TTL.DAILY);
    return res.json(facts);
  } catch (e) {
    console.error("[Home] facts error:", e.message);
    return res.status(500).json([]);
  }
});

// ── GET /api/home/sections ────────────────────────────────────
// Admin-configured visibility/order for Discovery's discretionary sections.

router.get("/home/sections", async (_req, res) => {
  const cacheKey = "home:sections";
  try {
    const mem = getCache(cacheKey);
    if (mem) return res.json(mem);

    const { data, error } = await supabase
      .from("home_sections")
      .select("*")
      .order("display_order", { ascending: true });

    if (error) throw new Error(error.message);

    const sections = data ?? [];
    setCache(cacheKey, sections, 5 * 60);
    return res.json(sections);
  } catch (e) {
    console.error("[Home] sections error:", e.message);
    return res.status(500).json([]);
  }
});

// ── GET /api/home/accuracy[/:slug] ────────────────────────────
// Real prediction accuracy %, global or per-league/bucket, admin-overridable.

router.get("/home/accuracy", async (_req, res) => {
  try {
    const result = await accuracyService.getGlobalAccuracyPublic();
    return res.json(result);
  } catch (e) {
    console.error("[Home] accuracy error:", e.message);
    return res.status(500).json({ percentage: 0, sampleSize: 0, isOverridden: false, computedPercentage: 0 });
  }
});

router.get("/home/accuracy/:slug", async (req, res) => {
  try {
    const result = await accuracyService.getLeagueAccuracyPublic(req.params.slug);
    if (!result) return res.status(404).json({ error: "Unknown league/bucket slug" });
    return res.json(result);
  } catch (e) {
    console.error(`[Home] accuracy/${req.params.slug} error:`, e.message);
    return res.status(500).json({ percentage: 0, sampleSize: 0, isOverridden: false, computedPercentage: 0 });
  }
});

router.get("/home/league-cards", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5, 10);
  try {
    return res.json({ cards: await accuracyService.getLeagueCardsPublic(limit) });
  } catch (e) {
    console.error("[Home] league-cards error:", e.message);
    return res.status(500).json({ cards: [] });
  }
});

// ── GET /api/home/bundle ──────────────────────────────────────
// Returns all Discovery-screen data in one request — eliminates the 15+
// parallel HTTP/1.1 calls that queue behind the 6-connection limit on mobile.
// Everything runs in parallel on the server (no connection limit here).

router.get("/home/bundle", async (_req, res) => {
  const cacheKey = "home:bundle:v1";
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    // homeBundle: false → league appears in Matches picker but skips the home bundle
    const cricketLeagues = Object.values(LEAGUES).filter(l => l.homeBundle !== false);

    const [cricketResults, football, intlSeries, intlSchedule, news] =
      await Promise.all([
        // All cricket league match data in parallel — 8s per-league timeout so one
        // slow/absent league never blocks the whole bundle response.
        Promise.all(
          cricketLeagues.map(l => {
            const timeout = new Promise(resolve =>
              setTimeout(() => resolve({ slug: l.slug, live: [], upcoming: [], completed: [] }), 8_000)
            );
            const fetch = leagueService.getLeagueMatches(l)
              .then(d => ({ slug: l.slug, ...d }))
              .catch(() => ({ slug: l.slug, live: [], upcoming: [], completed: [] }));
            return Promise.race([fetch, timeout]);
          })
        ),
        footballService.getMatches().catch(() => ({ live: [], upcoming: [], completed: [] })),
        internationalService.getSeriesList().catch(() => []),
        internationalService.getScheduleFixtures(7).catch(() => ({ live: [], today: [], upcoming: [] })),
        fetchCricketNews().catch(() => []),
      ]);

    // Build slug → match data map
    const matches = {};
    for (const { slug, live, upcoming, completed } of cricketResults) {
      matches[slug] = { live: live ?? [], upcoming: upcoming ?? [], completed: completed ?? [] };
    }

    // leagueCards are fetched separately by the app via /api/home/league-cards.
    // Including them here runs under connection-pool pressure (16 parallel fixture fetches
    // above) and causes getCachedDataByPrefix("pred:light:") to silently return an empty
    // Map, poisoning the 1h accuracy cache with zeros.
    const bundle = { matches, football, intlSeries, intlSchedule, leagueCards: [], news };
    setCache(cacheKey, bundle, 5 * 60); // 5 min — WS handles live scores; match status rarely changes faster
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=240");
    return res.json(bundle);
  } catch (e) {
    console.error("[Home] bundle error:", e.message);
    return res.status(500).json({ error: "Bundle failed" });
  }
});

module.exports = router;
