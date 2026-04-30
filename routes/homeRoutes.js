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
const { normalizeRankings } = require("../services/sportmonksNormalizer");
const { fetchCricketNews }  = require("../services/newsService");
const { getCache, setCache } = require("../services/cacheService");
const { getCachedData, setCachedData } = require("../services/dbService");

const router = express.Router();

const CRICBUZZ_HOST = "cricbuzz-cricket.p.rapidapi.com";
const RANKINGS_TTL_S  = 6 * 60 * 60;
const RANKINGS_TTL_MS = RANKINGS_TTL_S * 1000;
const DB_RANKINGS_KEY = "home:rankings";

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

    // 3. Sportsmonks — team rankings
    const raw  = await sm.getTeamRankings();
    const { teams } = normalizeRankings(raw ?? []);

    // 4. Cricbuzz — individual player rankings (batsmen/bowlers)
    let batsmen = [], bowlers = [];
    if (process.env.CRICBUZZ_API_KEY) {
      try {
        const [batsRes, bowlRes] = await Promise.all([
          axios.get(`https://${CRICBUZZ_HOST}/stats/v1/rankings/batsmen`, {
            headers: cricbuzzHeaders(), params: { formatType: "t20" }, timeout: 8000,
          }),
          axios.get(`https://${CRICBUZZ_HOST}/stats/v1/rankings/bowlers`, {
            headers: cricbuzzHeaders(), params: { formatType: "t20" }, timeout: 8000,
          }),
        ]);
        batsmen = (batsRes.data?.rank ?? []).slice(0, 10).map(r => ({
          id: String(r.id), rank: Number(r.rank), name: r.name,
          country: r.country, rating: Number(r.rating), points: Number(r.points),
          trend: r.trend || "Flat",
          imageUrl: r.faceImageId
            ? `https://cricbuzz-static.s3.amazonaws.com/media/img/oneline/${r.faceImageId}.jpg`
            : null,
        }));
        bowlers = (bowlRes.data?.rank ?? []).slice(0, 10).map(r => ({
          id: String(r.id), rank: Number(r.rank), name: r.name,
          country: r.country, rating: Number(r.rating), points: Number(r.points),
          trend: r.trend || "Flat",
          imageUrl: r.faceImageId
            ? `https://cricbuzz-static.s3.amazonaws.com/media/img/oneline/${r.faceImageId}.jpg`
            : null,
        }));
      } catch { /* Cricbuzz unavailable — proceed without player rankings */ }
    }

    const result = { batsmen, bowlers, teams };
    await setCachedData(DB_RANKINGS_KEY, result);
    setCache(DB_RANKINGS_KEY, result, RANKINGS_TTL_S);
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

// ── GET /api/img/news/:imageId ────────────────────────────────

router.get("/img/news/:imageId", async (req, res) => {
  const { imageId } = req.params;
  if (!/^\d+$/.test(imageId)) return res.status(400).end();
  try {
    const response = await axios.get(
      `https://cricbuzz-cricket.p.rapidapi.com/img/v1/i1/c${imageId}/i.jpg`,
      { headers: cricbuzzHeaders(), responseType: "stream", timeout: 10_000 },
    );
    res.set("Content-Type", response.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    response.data.pipe(res);
  } catch {
    res.status(404).end();
  }
});

module.exports = router;
