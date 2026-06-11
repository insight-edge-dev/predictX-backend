/**
 * newsService.js — Cricket news from Cricbuzz RapidAPI.
 *
 * Endpoint: GET /news/v1/index  (returns storyList array)
 *
 * Cache tiers (30 min TTL — news updates frequently):
 *   1. NodeCache (in-memory, 30 min)
 *   2. Supabase DB  (persistent, 30 min) — survives restarts
 *   3. Cricbuzz API — source of truth
 */

const axios                            = require("axios");
const { getCache, setCache }           = require("./cacheService");
const { getCachedData, setCachedData } = require("./dbService");

const BASE    = "https://cricbuzz-cricket.p.rapidapi.com";
const TTL_S   = 6 * 60 * 60;   // 6h — preserve Cricbuzz quota (was 30 min)
const TTL_MS  = TTL_S * 1000;
const DB_KEY  = "home:news";

function headers() {
  return {
    "x-rapidapi-host": "cricbuzz-cricket.p.rapidapi.com",
    "x-rapidapi-key":  process.env.CRICBUZZ_API_KEY,
    "Content-Type":    "application/json",
  };
}

/**
 * Image proxy URL served by our own backend.
 * The imageId comes from the story's coverImage.id field.
 * The actual fetch happens in the /api/img/news/:id route.
 */
function newsImgUrl(imageId) {
  if (!imageId) return null;
  return `/api/img/news/${imageId}`;   // resolved at runtime with base URL
}

function normalizeStory(story) {
  return {
    id:          story.id,
    title:       story.hline || "",
    description: story.intro || "",
    context:     story.context || "",
    storyType:   story.storyType || "",
    imageId:     story.coverImage?.id || story.imageId || null,
    image:       newsImgUrl(story.coverImage?.id || story.imageId),
    pubTime:     story.pubTime ? Number(story.pubTime) : null,
    source:      story.source || "Cricbuzz",
  };
}

async function fetchCricketNews() {
  // Tier 1: NodeCache
  const memCached = getCache(DB_KEY);
  if (memCached) {
    console.log("[News] from NodeCache");
    return memCached;
  }

  // Tier 2: Supabase DB
  const dbCached = await getCachedData(DB_KEY, TTL_MS);
  if (dbCached) {
    console.log("[News] from DB cache");
    setCache(DB_KEY, dbCached, TTL_S);
    return dbCached;
  }

  // Tier 3: Cricbuzz API
  if (!process.env.CRICBUZZ_API_KEY) {
    console.warn("[News] CRICBUZZ_API_KEY not set");
    return [];
  }

  console.log("[News] fetching from Cricbuzz API");
  try {
    const { data } = await axios.get(`${BASE}/news/v1/index`, {
      headers: headers(),
      timeout: 10_000,
    });

    const stories = (data.storyList || [])
      .filter(item => item.story)          // skip ads
      .map(item => normalizeStory(item.story))
      .filter(s => s.title)
      .slice(0, 10);

    if (stories.length > 0) {
      await setCachedData(DB_KEY, stories);
      setCache(DB_KEY, stories, TTL_S);
      console.log(`[News] ${stories.length} stories saved to DB + NodeCache`);
    }
    return stories;
  } catch (e) {
    console.error("[News] Cricbuzz API error:", e.message);
    return [];
  }
}

module.exports = { fetchCricketNews };
