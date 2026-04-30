/**
 * playerController.js — handlers for /api/players/* routes.
 * Data source: Sportsmonks Cricket API.
 */

const sm  = require("../services/sportmonksService");
const db  = require("../services/dbService");
const {
  normalizePlayerSummary,
  normalizePlayerProfile,
} = require("../services/sportmonksNormalizer");
const { getCache, setCache, TTL, KEYS } = require("../services/cacheService");

// ── GET /api/players?page= ────────────────────────────────────

async function getPlayers(req, res) {
  const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
  const cacheKey = `${KEYS.PLAYER_LIST}:${page}`;

  try {
    const mem = getCache(cacheKey);
    if (mem) return res.json({ players: mem, page });

    const raw     = await sm.getPlayersList(page);
    const players = Array.isArray(raw)
      ? raw.map(normalizePlayerSummary).filter(Boolean)
      : [];

    setCache(cacheKey, players, TTL.PLAYERS);
    return res.json({ players, page });
  } catch (e) {
    console.error("[Player] getPlayers:", e.message);
    return res.status(500).json({ players: [], page });
  }
}

// ── GET /api/players/search?q= ────────────────────────────────

async function searchPlayers(req, res) {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Query param 'q' is required" });

  const cacheKey = KEYS.PLAYER_SEARCH(q);
  try {
    const mem = getCache(cacheKey);
    if (mem) return res.json({ players: mem, query: q });

    const raw     = await sm.searchPlayers(q);
    const players = Array.isArray(raw)
      ? raw.map(normalizePlayerSummary).filter(Boolean)
      : [];

    setCache(cacheKey, players, TTL.PLAYERS);
    return res.json({ players, query: q });
  } catch (e) {
    console.error(`[Player] searchPlayers("${q}"):`, e.message);
    return res.status(500).json({ players: [], query: q });
  }
}

// ── GET /api/players/:id ──────────────────────────────────────
// NodeCache → DB → Sportsmonks API

async function getPlayerById(req, res) {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "Player id required" });

  const cacheKey = KEYS.PLAYER_INFO(id);
  try {
    // 1. NodeCache
    const mem = getCache(cacheKey);
    if (mem) return res.json(mem);

    // 2. DB (player profiles are static)
    const fromDB = await db.getPlayer(id);
    if (fromDB) {
      setCache(cacheKey, fromDB, TTL.PLAYERS);
      return res.json(fromDB);
    }

    // 3. Sportsmonks API
    const raw    = await sm.getPlayer(id);
    const player = normalizePlayerProfile(raw);
    if (!player) return res.status(404).json({ error: "Player not found" });

    void db.savePlayer(id, player);
    setCache(cacheKey, player, TTL.PLAYERS);
    return res.json(player);
  } catch (e) {
    console.error(`[Player] getPlayerById(${id}):`, e.message);
    return res.status(500).json({ error: "Failed to fetch player" });
  }
}

module.exports = { getPlayers, searchPlayers, getPlayerById };
