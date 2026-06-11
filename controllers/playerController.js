/**
 * playerController.js — handlers for /api/players/* routes.
 * Data source: Sportsmonks Cricket API.
 */

const sm  = require("../services/sportmonksService");
const db  = require("../services/dbService");
const {
  normalizePlayerSummary,
  normalizePlayerProfile,
  normalizeCareerStats,
} = require("../services/sportmonksNormalizer");
const { getCache, setCache, TTL, KEYS } = require("../services/cacheService");

// IPL team IDs (Sportsmonks) — pre-load squads for player search
const IPL_TEAM_IDS = [2, 3, 4, 5, 6, 7, 8, 9, 1976, 1979];
const IPL_SEASON_ID = Number(process.env.IPL_SEASON_ID || 1795);

const SQUAD_CACHE_KEY = `ipl:squad:all:${IPL_SEASON_ID}`;

// Builds a deduplicated player list from all IPL team squads.
// Cached for 24 h — squads rarely change during a season.
async function getAllIPLSquadPlayers() {
  const mem = getCache(SQUAD_CACHE_KEY);
  if (mem) return mem;

  try {
    const squads = await Promise.all(
      IPL_TEAM_IDS.map(id => sm.getTeamSquad(id, IPL_SEASON_ID))
    );

    const seen   = new Set();
    const result = [];

    for (const squad of squads) {
      if (!Array.isArray(squad)) continue;
      for (const p of squad) {
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        result.push({
          id:           String(p.id),
          name:         p.fullname || `${p.firstname || ""} ${p.lastname || ""}`.trim(),
          role:         _mapPosition(p.position?.name),
          battingStyle: p.battingstyle  || "",
          bowlingStyle: p.bowlingstyle  || "",
          country:      "",                          // not in squad response
          logo:         p.image_path || "",
        });
      }
    }

    console.log(`[Player] squad index built: ${result.length} players`);
    setCache(SQUAD_CACHE_KEY, result, TTL.DAILY);
    return result;
  } catch (e) {
    console.error("[Player] getAllIPLSquadPlayers:", e.message);
    return [];
  }
}

function _mapPosition(pos) {
  if (!pos) return "ALL";
  const p = pos.toLowerCase();
  if (p.includes("wicket"))   return "WK-BAT";
  if (p.includes("allround")) return "ALL";
  if (p.includes("bowl"))     return "BOL";
  if (p.includes("bat"))      return "BAT";
  return "ALL";
}

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

    // Build search from IPL squad data — reliable, no subscription restriction
    const allPlayers = await getAllIPLSquadPlayers();
    const qLower     = q.toLowerCase();
    const tokens     = qLower.split(/\s+/).filter(t => t.length > 1);

    const players = allPlayers.filter(p => {
      const nameLower = p.name.toLowerCase();
      // Match if name contains the full query OR every token matches
      return nameLower.includes(qLower)
        || tokens.every(tok => nameLower.includes(tok));
    });

    console.log(`[Player] search "${q}": ${players.length}/${allPlayers.length} matched`);

    if (players.length > 0) {
      setCache(cacheKey, players, 5 * 60); // 5 min cache for search results
    }
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

    // Attach career stats (from include=career)
    const careerStats = normalizeCareerStats(raw?.career ?? null);
    const enriched = { ...player, careerStats };

    void db.savePlayer(id, enriched);
    setCache(cacheKey, enriched, TTL.PLAYERS);
    return res.json(enriched);
  } catch (e) {
    console.error(`[Player] getPlayerById(${id}):`, e.message);
    return res.status(500).json({ error: "Failed to fetch player" });
  }
}

module.exports = { getPlayers, searchPlayers, getPlayerById };
