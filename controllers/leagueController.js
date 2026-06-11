/**
 * leagueController.js — HTTP handlers for multi-league endpoints.
 *
 * Routes (all prefixed /api):
 *   GET /leagues                     → all Sportsmonks leagues (dynamic)
 *   GET /leagues/:slug/matches
 *   GET /leagues/:slug/live
 *   GET /leagues/:slug/upcoming
 *   GET /leagues/:slug/results
 *   GET /leagues/:slug/fixtures
 *   GET /leagues/:slug/table
 */

const { LEAGUES, FOOTBALL_LEAGUES, getLeague } = require("../config/leaguesConfig");

// Football leagues as a flat array ready for the API response
const FOOTBALL_LEAGUE_LIST = Object.values(FOOTBALL_LEAGUES).map(l => ({
  slug: l.slug, leagueId: l.leagueId, seasonId: null,
  stageId: null, playoffId: null,
  name: l.name, short: l.short, season: l.season,
  flag: l.flag, country: l.country, format: l.format, image: "",
  sport: l.sport,
}));
const leagueService            = require("../services/leagueService");
const sm                       = require("../services/sportmonksService");
const { getCache, setCache, TTL } = require("../services/cacheService");

// Generic international buckets that are NOT real franchise leagues — they
// contain hundreds of unrelated bilateral tours and are handled separately
// by the /api/international/* section.  Exclude them from the league picker
// so users don't accidentally select them and see an empty, unsorted list.
const INTL_BUCKET_IDS = new Set([3, 258, 261]); // T20I, Women's T20I, Women's ODI

// ── Country → flag emoji ──────────────────────────────────────

const COUNTRY_FLAGS = {
  India:         "🏏",  Pakistan:      "🟢",  Australia:     "🦘",
  Bangladesh:    "🟥",  England:       "🏴󠁧󠁢󠁥󠁮󠁧󠁿",  "South Africa":"🦁",
  "West Indies": "🌐",  International: "🌍",  "Sri Lanka":   "🦁",
  Afghanistan:   "🏔",  "New Zealand": "🥝",  Zimbabwe:      "🌿",
  Ireland:       "☘️",  Scotland:      "🏴󠁧󠁢󠁳󠁣󠁴󠁿",  "United Arab Emirates": "🏜",
  USA:           "🇺🇸", Canada:        "🍁",  Netherlands:   "🌷",
};

function countryFlag(countryName) {
  return COUNTRY_FLAGS[countryName] ?? "🏏";
}

// Derive a URL-safe slug from Sportsmonks code/name
function makeSlug(code, name, id) {
  if (code) return code.toLowerCase().replace(/[^a-z0-9]/g, "_");
  if (name) return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);
  return `league_${id}`;
}

// Ensure every slug in the list is unique — append _leagueId on collision
function deduplicateSlugs(leagues) {
  const seen = new Set();
  return leagues.map(l => {
    let slug = l.slug;
    if (seen.has(slug)) slug = `${slug}_${l.leagueId}`;
    seen.add(slug);
    return { ...l, slug };
  });
}

// ── GET /api/leagues ──────────────────────────────────────────
// Fetches all leagues from Sportsmonks, merges with known config
// for stage IDs, caches 24 h.

async function listLeagues(_req, res) {
  const MEM_KEY = "all_leagues_dynamic";
  const cached  = getCache(MEM_KEY);
  if (cached) return res.json({ leagues: cached });

  // Two parallel calls: all leagues + recent seasons (to find current season per league)
  const [rawLeagues, rawSeasons] = await Promise.all([
    sm.getAllLeagues(),
    sm.getRecentSeasons(),
  ]);

  if (!rawLeagues || !Array.isArray(rawLeagues) || rawLeagues.length === 0) {
    // API failed — return hardcoded config as fallback
    const list = Object.values(LEAGUES).map(l => ({
      slug: l.slug, leagueId: l.leagueId, seasonId: l.seasonId,
      stageId: l.stageId, playoffId: l.playoffId,
      name: l.name, short: l.short, season: l.season,
      flag: l.flag, country: l.country, format: l.format, image: "",
    }));
    console.warn("[LeagueCtrl] listLeagues: Sportsmonks returned no data — using hardcoded config");
    return res.json({ leagues: [...list, ...FOOTBALL_LEAGUE_LIST] });
  }

  // Build leagueId → most-recent season map from batch response
  const seasonByLeague = {};
  if (Array.isArray(rawSeasons)) {
    console.log(`[LeagueCtrl] batch seasons: ${rawSeasons.length} entries`);
    for (const s of rawSeasons) {
      // Sportsmonks may use league_id or leagueId
      const lid = s.league_id ?? s.leagueId;
      if (lid && !seasonByLeague[lid]) seasonByLeague[lid] = s;
    }
    console.log(`[LeagueCtrl] seasons mapped for ${Object.keys(seasonByLeague).length} leagues`);
  } else {
    console.warn("[LeagueCtrl] getRecentSeasons returned non-array:", typeof rawSeasons);
  }

  const known = Object.values(LEAGUES);

  // For leagues missing from batch, fetch season individually (parallel, max 10 at a time)
  const missing = rawLeagues.filter(l =>
    !known.find(k => k.leagueId === l.id) && !seasonByLeague[l.id]
  );
  if (missing.length > 0) {
    console.log(`[LeagueCtrl] fetching seasons individually for ${missing.length} leagues`);
    const chunks = [];
    for (let i = 0; i < missing.length; i += 10)
      chunks.push(missing.slice(i, i + 10));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async l => {
        const s = await sm.getSeasonForLeague(l.id);
        if (s) seasonByLeague[l.id] = s;
      }));
    }
  }

  const leagues = rawLeagues
    .map(l => {
      const slug      = makeSlug(l.code, l.name, l.id);
      const knownConf = known.find(k => k.leagueId === l.id) ?? null;
      const season    = seasonByLeague[l.id] ?? null;
      const seasonId  = knownConf?.seasonId ?? season?.id   ?? null;
      const yearLabel = knownConf?.season   ?? String(season?.name ?? season?.year ?? "");

      return {
        slug,
        leagueId:  l.id,
        seasonId,
        stageId:   knownConf?.stageId   ?? null,
        playoffId: knownConf?.playoffId ?? null,
        name:      l.name        ?? "",
        short:     l.code        ?? l.name?.slice(0, 6) ?? "",
        season:    yearLabel,
        flag:      knownConf?.flag ?? countryFlag(l.country?.name),
        country:   l.country?.name ?? "",
        format:    "T20",
        image:     l.image_path  ?? "",
      };
    })
    .filter(l => l.seasonId && !INTL_BUCKET_IDS.has(l.leagueId))  // exclude international buckets
    .sort((a, b) => {
      const aK = !!known.find(k => k.leagueId === a.leagueId);
      const bK = !!known.find(k => k.leagueId === b.leagueId);
      if (aK && !bK) return -1;
      if (!aK && bK) return  1;
      return a.name.localeCompare(b.name);
    });

  const unique = deduplicateSlugs([...leagues, ...FOOTBALL_LEAGUE_LIST]);
  setCache(MEM_KEY, unique, TTL.DAILY);
  console.log(`[LeagueCtrl] listLeagues: ${unique.length} leagues total (incl. football)`);
  res.json({ leagues: unique });
}

// ── Resolve league from slug ──────────────────────────────────
// Checks hardcoded config first, then dynamic cache, then Sportsmonks API.

async function resolveLeagueDynamic(slug) {
  // 1. Hardcoded config
  const conf = getLeague(slug);
  if (conf) return conf;

  // 2. Dynamic cache
  const cached = getCache("all_leagues_dynamic");
  if (cached) {
    const found = cached.find(l => l.slug === slug);
    if (found) return found;
  }

  // 3. Fetch fresh from Sportsmonks
  const raw = await sm.getAllLeagues();
  if (!raw) return null;
  const known = Object.values(LEAGUES);
  const match = raw.find(l => makeSlug(l.code, l.name, l.id) === slug);
  if (!match) return null;

  // getAllLeagues() doesn't include `currentseason` — resolve it the same
  // reliable way listLeagues() does (batch seasons don't cover every league).
  const knownConf = known.find(k => k.leagueId === match.id);
  const seasonId  = knownConf?.seasonId ?? null;
  let   season    = null;
  if (!seasonId) {
    season = await sm.getSeasonForLeague(match.id);
    if (!season?.id) return null;
  }

  return {
    slug,
    leagueId:  match.id,
    seasonId:  seasonId ?? season.id,
    stageId:   knownConf?.stageId   ?? null,
    playoffId: knownConf?.playoffId ?? null,
    name:      match.name  ?? "",
    short:     match.code  ?? "",
    season:    knownConf?.season ?? String(season?.name ?? season?.year ?? ""),
    flag:      knownConf?.flag ?? countryFlag(match.country?.name),
    country:   match.country?.name ?? "",
    format:    "T20",
  };
}

// ── Helper used by all data handlers ─────────────────────────

async function resolve(req, res) {
  const league = await resolveLeagueDynamic(req.params.slug);
  if (!league) {
    res.status(404).json({ error: `Unknown league: ${req.params.slug}` });
    return null;
  }
  return league;
}

// ── GET /api/leagues/:slug/matches ────────────────────────────

async function getMatches(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json(await leagueService.getLeagueMatches(league));
  } catch (e) {
    console.error(`[League:${req.params.slug}] getMatches:`, e.message);
    res.status(500).json({ error: "Failed to fetch matches" });
  }
}

async function getLive(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { live } = await leagueService.getLeagueMatches(league);
    res.json({ live });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch live" });
  }
}

async function getUpcoming(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { upcoming } = await leagueService.getLeagueMatches(league);
    res.json({ upcoming });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch upcoming" });
  }
}

async function getResults(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { completed } = await leagueService.getLeagueMatches(league);
    res.json({ completed });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch results" });
  }
}

async function getFixtures(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json({ fixtures: await leagueService.getLeagueFixtures(league) });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch fixtures" });
  }
}

async function getTable(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json({ table: await leagueService.getLeagueTable(league) });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch standings" });
  }
}

module.exports = { listLeagues, getMatches, getLive, getUpcoming, getResults, getFixtures, getTable };
