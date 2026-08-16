/**
 * leagueController.js — HTTP handlers for multi-league endpoints.
 *
 * Routes (all prefixed /api):
 *   GET /leagues                     → all leagues (from local config + hl_fixtures activity)
 *   GET /leagues/:slug/matches
 *   GET /leagues/:slug/live
 *   GET /leagues/:slug/upcoming
 *   GET /leagues/:slug/results
 *   GET /leagues/:slug/fixtures
 *   GET /leagues/:slug/table
 *
 * Data source: local leaguesConfig.js + highlightlyConfig.js (no Sportsmonks).
 * Activity detection: hl_fixtures table (which leagues have matches in the window).
 */

const { LEAGUES, FOOTBALL_LEAGUES, getLeague } = require("../config/leaguesConfig");
const { getLeagueByHLId, HL_CRICKET_LEAGUES, HL_FOOTBALL_LEAGUES } = require("../config/highlightlyConfig");
const storage                  = require("../services/highlightlyStorageService");

// Football leagues as a flat array ready for the API response
const FOOTBALL_LEAGUE_LIST = Object.values(FOOTBALL_LEAGUES).map(l => ({
  slug: l.slug, leagueId: l.leagueId ?? 0, seasonId: null,
  stageId: null, playoffId: null,
  name: l.name, short: l.short, season: l.season,
  flag: l.flag, country: l.country, format: l.format, image: "",
  sport: l.sport, homeBundle: l.homeBundle !== false,
}));
const leagueService            = require("../services/leagueService");
const { getCache, setCache, TTL } = require("../services/cacheService");
const supabase                 = require("../config/supabase");

// Admin-set "featured/pinned" override (league_settings table) — merged onto
// every league object so the Matches/PredictX accordions can sort featured
// leagues to the top. Higher priority = shown first; 0 = no override.
async function attachPriority(leagues) {
  try {
    const { data, error } = await supabase.from("league_settings").select("slug, priority");
    if (error) throw new Error(error.message);
    const prioMap = new Map((data ?? []).map(s => [s.slug, s.priority]));
    return leagues.map(l => ({ ...l, priority: prioMap.get(l.slug) ?? 0 }));
  } catch (e) {
    console.warn("[LeagueCtrl] attachPriority failed —", e.message);
    return leagues.map(l => ({ ...l, priority: 0 }));
  }
}

// Generic international buckets that are NOT real franchise leagues — they
// contain hundreds of unrelated bilateral tours and are handled separately
// by the /api/international/* section.  Exclude them from the league picker
// so users don't accidentally select them and see an empty, unsorted list.
const INTL_BUCKET_IDS = new Set([3, 258, 261]); // T20I, Women's T20I, Women's ODI

// Minimum season year to show — filters out very old/discontinued leagues
// that haven't run since before this threshold (e.g. WCSL 2018, Finland 2020).
const MIN_SEASON_YEAR = 2024;

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

// ── Activity window: which league slugs have fixtures right now ─
// Queries hl_fixtures for the window; maps HL leagueIds → config slugs.
// Window: 10 days ago → 45 days ahead. Cached 4 h.

const ACTIVITY_WINDOW_DAYS_BACK   = 180;
const ACTIVITY_WINDOW_DAYS_AHEAD  = 180;

async function getActiveLeagueSlugs() {
  const CACHE_KEY = "active_league_slugs_v3";
  const cached    = getCache(CACHE_KEY);
  if (cached) return new Set(cached);

  // Always include all configured cricket leagues whose currentSeason is recent
  // (within the last year). This prevents leagues like LPL, MLC, The Hundred from
  // disappearing when their warehouse data hasn't been synced yet (e.g. due to
  // API quota exhaustion). The frontend's homeBundle:false filter still hides
  // domestic leagues (Ranji, SMAT) from the all-leagues view.
  const currentYear = new Date().getFullYear();
  const slugs = new Set(
    Object.entries(HL_CRICKET_LEAGUES)
      .filter(([, l]) => l.currentSeason >= currentYear - 1)
      .map(([slug]) => slug)
  );

  const now  = Date.now();
  const from = new Date(now - ACTIVITY_WINDOW_DAYS_BACK  * 86_400_000).toISOString().slice(0, 10);
  const to   = new Date(now + ACTIVITY_WINDOW_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);

  try {
    const { data } = await supabase
      .from("hl_fixtures")
      .select("league_id")
      .gte("start_date", `${from}T00:00:00.000Z`)
      .lte("start_date", `${to}T23:59:59.999Z`);

    const hlIds = [...new Set((data || []).map(r => String(r.league_id)).filter(Boolean))];
    for (const hlId of hlIds) {
      const conf = getLeagueByHLId(hlId);
      if (conf) slugs.add(conf.slug);
    }

    console.log(`[LeagueCtrl] active league slugs (${slugs.size}): ${[...slugs].join(", ")}`);
    setCache(CACHE_KEY, [...slugs], 4 * 60 * 60);
    return slugs;
  } catch (e) {
    console.warn("[LeagueCtrl] getActiveLeagueSlugs DB query failed:", e.message);
    // Still return the configured leagues even without DB data
    setCache(CACHE_KEY, [...slugs], 30 * 60); // shorter TTL so DB retried sooner
    return slugs;
  }
}

// ── Auto-discovered leagues from hl_fixtures ──────────────────
// Leagues that appeared in the ±180 day window via syncTodayMatches /
// syncNewLeagueSchedules but are NOT mapped in highlightlyConfig.js.
// These get slug `hl_<leagueId>` and metadata from hl_leagues.

// Derives a readable short tag from a league name
function _shortFromName(name = "") {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 6).toUpperCase();
  return words.map(w => w[0]).join("").slice(0, 5).toUpperCase();
}

async function buildAutoDiscoveredLeagues() {
  const CACHE_KEY = "auto_discovered_leagues_v2";
  const cached = getCache(CACHE_KEY);
  if (cached) return cached;

  try {
    const allIds    = await storage.getDiscoveredLeagueIds();
    const unknownIds = allIds.filter(id => !getLeagueByHLId(id));
    if (!unknownIds.length) { setCache(CACHE_KEY, [], 30 * 60); return []; }

    const metaRows = await storage.getLeagueMeta(unknownIds);
    const result   = metaRows.map(l => ({
      slug:       `hl_${l.id}`,
      leagueId:   0,
      seasonId:   null,
      stageId:    null,
      playoffId:  null,
      name:       l.name || `League ${l.id}`,
      short:      _shortFromName(l.name) || `HL${String(l.id).slice(-4)}`,
      season:     new Date().getFullYear().toString(),
      flag:       l.sport === "football" ? "⚽" : "🏏",
      country:    l.country_name || "International",
      format:     l.sport === "football" ? "Football" : "T20",
      image:      l.logo || "",
      sport:      l.sport || "cricket",
      homeBundle: true,
      status:     "active",
      priority:   0,
    }));

    console.log(`[LeagueCtrl] auto-discovered ${result.length} new league(s): ${result.map(r => r.name).join(", ")}`);
    setCache(CACHE_KEY, result, 30 * 60);
    return result;
  } catch (e) {
    console.warn("[LeagueCtrl] buildAutoDiscoveredLeagues failed:", e.message);
    return [];
  }
}

// ── Raw league metadata — from local config (no external API) ─

// leaguesConfig slugs that differ from their highlightlyConfig key
const SLUG_ALIASES = { wc2026: "wc" };

// Maps a league slug to its Highlightly league ID (for logo lookup).
// Cricket: uses current season's ID. Football: uses the league's fixed ID.
function _hlIdForSlug(slug) {
  const s = SLUG_ALIASES[slug] ?? slug;
  if (s.startsWith("hl_")) return s.replace("hl_", "");
  const cricket = HL_CRICKET_LEAGUES[s];
  if (cricket) {
    return cricket.seasons[cricket.currentSeason]
        ?? Object.values(cricket.seasons).at(-1)
        ?? null;
  }
  const football = HL_FOOTBALL_LEAGUES[s];
  if (football) return football.id ?? null;
  return null;
}

async function buildRawLeagueList() {
  const RAW_KEY = "all_leagues_raw_v6";
  const cached  = getCache(RAW_KEY);
  if (cached) return cached;

  // Build from local config
  const configLeagues = Object.values(LEAGUES).map(l => ({
    slug:       l.slug,
    leagueId:   l.leagueId ?? 0,
    seasonId:   l.seasonId ?? null,
    stageId:    l.stageId  ?? null,
    playoffId:  l.playoffId ?? null,
    name:       l.name,
    short:      l.short,
    season:     l.season,
    flag:       l.flag,
    country:    l.country,
    format:     l.format || "T20",
    image:      "",
    sport:      l.sport || "cricket",
    homeBundle: l.homeBundle !== false,
  }));

  // Shallow-copy football list so we don't mutate the module-level constant
  const allConfig = [
    ...configLeagues,
    ...FOOTBALL_LEAGUE_LIST.map(l => ({ ...l })),
  ];

  // Enrich with logos from hl_leagues.
  // Cricket leagues: each season has its own HL ID, so query ALL season IDs
  // (newest first) and pick the first one that has a logo stored.
  // Football leagues: single fixed ID per league.
  try {
    const slugToOrderedIds = {};

    for (const [slug, conf] of Object.entries(HL_CRICKET_LEAGUES)) {
      const sortedIds = Object.entries(conf.seasons || {})
        .sort(([a], [b]) => Number(b) - Number(a))   // newest season first
        .map(([, id]) => String(id));
      if (sortedIds.length) slugToOrderedIds[slug] = sortedIds;
    }
    for (const [key, conf] of Object.entries(HL_FOOTBALL_LEAGUES)) {
      const slug = conf.slug || key;
      if (conf.id) slugToOrderedIds[slug] = [String(conf.id)];
    }
    // Fallback for any league not covered above
    for (const l of allConfig) {
      if (!slugToOrderedIds[l.slug]) {
        const id = _hlIdForSlug(l.slug);
        if (id) slugToOrderedIds[l.slug] = [String(id)];
      }
    }

    const allHLIds = [...new Set(Object.values(slugToOrderedIds).flat())];
    if (allHLIds.length) {
      const metaRows = await storage.getLeagueMeta(allHLIds);
      const logoMap  = new Map(metaRows.filter(m => m.logo).map(m => [String(m.id), m.logo]));
      console.log(`[LeagueCtrl] logo enrichment: queried ${allHLIds.length} IDs, found ${logoMap.size} logos`);

      for (const l of allConfig) {
        if (l.image) continue;
        for (const id of (slugToOrderedIds[l.slug] || [])) {
          if (logoMap.has(id)) { l.image = logoMap.get(id); break; }
        }
      }
    }
  } catch (e) {
    console.warn("[LeagueCtrl] logo enrichment failed:", e.message);
  }

  const result = deduplicateSlugs(allConfig);
  setCache(RAW_KEY, result, TTL.DAILY);
  return result;
}

// ── GET /api/leagues ──────────────────────────────────────────
// Returns ALL accessible leagues with a `status` field:
//   'active'    — has fixtures in the -10 d / +45 d window (ongoing or upcoming)
//   'completed' — no fixtures in window (season finished)
// Raw metadata cached 24 h; activity window refreshes every 4 h.
// Leagues with seasons older than MIN_SEASON_YEAR are excluded.
// Sort order: active leagues first (known-config → alphabetical),
//             then completed leagues (known-config → alphabetical).

function seasonYear(s) {
  return parseInt(String(s || "0").slice(0, 4)) || 0;
}

async function listLeagues(_req, res) {
  try {
    // 1. Raw metadata (24 h cache) — always succeeds (built from local config)
    const raw = await buildRawLeagueList();

    // 2. Activity window (4 h cache) — maps HL league IDs → slugs via hl_fixtures
    const activeSlugs = await getActiveLeagueSlugs();

    // 3. Auto-discovered leagues (30 min cache) — leagues found in hl_fixtures
    //    that are not mapped in highlightlyConfig.js (e.g. CPL, ILT20 etc.)
    const discovered = await buildAutoDiscoveredLeagues();

    // 4. Merge: prefer config entries, then discovered (dedup by slug AND name).
    //    Auto-discovered leagues sometimes shadow a configured league under a
    //    different HL ID (e.g. "Bundesliga · International" next to
    //    "Bundesliga · Germany"). Drop any discovered entry whose name already
    //    exists in the config list.
    const existingSlugs = new Set(raw.map(l => l.slug));
    const existingNames = new Set(raw.map(l => l.name.toLowerCase().trim()));
    const newDiscovered = discovered.filter(l =>
      !existingSlugs.has(l.slug) && !existingNames.has(l.name.toLowerCase().trim())
    );

    // 5. Filter out very old leagues and attach status
    const withStatus = [...raw, ...newDiscovered]
      .filter(l => l.sport === "football" || seasonYear(l.season) >= MIN_SEASON_YEAR)
      .map(l => ({
        ...l,
        status: (l.sport === "football" || l.status === "active" || activeSlugs.has(l.slug)) ? "active" : "completed",
      }));

    // 4. Sort: active first, then alphabetical
    withStatus.sort((a, b) => {
      const aActive = a.status === "active", bActive = b.status === "active";
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return  1;
      return a.name.localeCompare(b.name);
    });

    const result = await attachPriority(withStatus);
    const activeCount    = result.filter(l => l.status === "active").length;
    const completedCount = result.filter(l => l.status === "completed").length;
    console.log(`[LeagueCtrl] listLeagues: ${result.length} leagues (${activeCount} active, ${completedCount} completed)`);
    res.json({ leagues: result });
  } catch (e) {
    console.error("[LeagueCtrl] listLeagues error:", e.message);
    res.status(500).json({ error: "Failed to fetch leagues" });
  }
}

// ── Resolve league from slug ──────────────────────────────────
// Checks hardcoded config first, then the raw league list cache.

async function resolveLeagueDynamic(slug) {
  // 1. Hardcoded config
  const conf = getLeague(slug);
  if (conf) return conf;

  // 2. Raw list cache (built by buildRawLeagueList on first call)
  const cached = getCache("all_leagues_raw_v6");
  if (cached) {
    const found = cached.find(l => l.slug === slug);
    if (found) return found;
  }

  // 2b. Auto-discovered leagues cache (populated by buildAutoDiscoveredLeagues in listLeagues)
  const discovered = getCache("auto_discovered_leagues_v2");
  if (discovered) {
    const found = discovered.find(l => l.slug === slug);
    if (found) return found;
  }

  // 3. Auto-discovered league: slug = "hl_<leagueId>"
  if (slug.startsWith("hl_")) {
    const hlId     = slug.replace("hl_", "");
    const metaRows = await storage.getLeagueMeta([hlId]);
    const l        = metaRows[0];
    if (l) {
      return {
        slug,
        sport:  l.sport || "cricket",
        season: new Date().getFullYear().toString(),
        name:   l.name || slug,
        short:  _shortFromName(l.name),
        flag:   "🏏",
        country: l.country_name || "International",
        format:  "T20",
        image:   l.logo || "",
      };
    }
  }

  return null;
}

// ── GET /api/leagues/:slug/seasons ────────────────────────────
// Returns available season years for the league so the client
// can render a year picker. Only years with a known HL ID are listed
// (i.e. years we actually have data for).

async function getSeasons(req, res) {
  const slug      = req.params.slug;
  const cacheKey  = `league:seasons:${slug}`;
  const cached    = getCache(cacheKey);
  if (cached) return res.json(cached);

  // Cricket: each season has its own unique HL league_id.
  // Only return seasons that have actual fixture rows in the warehouse.
  const hlCricket = HL_CRICKET_LEAGUES[slug];
  if (hlCricket?.seasons && !Array.isArray(hlCricket.seasons)) {
    const allYears = Object.keys(hlCricket.seasons).map(Number).sort((a, b) => b - a);
    const current  = hlCricket.currentSeason;

    // Probe every season in parallel. Current season is always included (may be in-progress).
    const hasData = await Promise.all(
      allYears.map(y =>
        y === current
          ? Promise.resolve(true)
          : storage.hasFixturesForSeason(hlCricket.seasons[y])
      )
    );
    const seasons = allYears.filter((_, i) => hasData[i]);
    const result  = { seasons: seasons.length ? seasons : [current], current };
    setCache(cacheKey, result, 6 * 3600); // season availability rarely changes
    return res.json(result);
  }

  // Football: single HL id per league — check per-season via date range.
  const hlFootball = HL_FOOTBALL_LEAGUES[slug];
  if (hlFootball) {
    const rawYears = Array.isArray(hlFootball.seasons)
      ? [...hlFootball.seasons].sort((a, b) => b - a)
      : [hlFootball.currentSeason ?? new Date().getFullYear()];
    const current = hlFootball.currentSeason ?? rawYears[0];

    if (rawYears.length <= 1) {
      const result = { seasons: rawYears, current };
      setCache(cacheKey, result, 6 * 3600);
      return res.json(result);
    }

    // Probe each season against the warehouse date range
    const hasData = await Promise.all(
      rawYears.map(y =>
        y === current
          ? Promise.resolve(true)
          : storage.hasFixturesForFootballSeason(hlFootball.id, y)
      )
    );
    const seasons = rawYears.filter((_, i) => hasData[i]);
    const result  = { seasons: seasons.length ? seasons : [current], current };
    setCache(cacheKey, result, 6 * 3600);
    return res.json(result);
  }

  // Auto-discovered or unknown: single current year only
  const league = await resolveLeagueDynamic(slug);
  if (!league) return res.status(404).json({ error: `Unknown league: ${slug}` });
  const current = Number(league.season) || new Date().getFullYear();
  const result  = { seasons: [current], current };
  setCache(cacheKey, result, 6 * 3600);
  return res.json(result);
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

// Returns the league config with the season overridden by ?season= query param.
function withSeasonOverride(league, req) {
  const s = req.query.season ? parseInt(req.query.season, 10) : null;
  if (!s || isNaN(s)) return league;
  return { ...league, season: String(s) };
}

// ── GET /api/leagues/:slug/matches ────────────────────────────

async function getMatches(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { live, upcoming, completed } = await leagueService.getLeagueMatches(withSeasonOverride(league, req));

    // Annotate completed cricket matches with scorecard availability.
    // Cached for 10 min per league — avoids a DB query on every concurrent request.
    let annotatedCompleted = completed;
    if (completed.length > 0 && league.sport !== "football") {
      const scKey = `scorecard:avail:${league.slug}:${league.season}`;
      let hasScorecard = getCache(scKey);
      if (!hasScorecard) {
        const ids = completed.map(m => String(m.id));
        hasScorecard = await storage.getScorecardAvailability(ids);
        setCache(scKey, hasScorecard, 10 * 60);
      }
      annotatedCompleted = completed.map(m => ({
        ...m,
        hasScorecard: hasScorecard.has(String(m.id)),
      }));
    }

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.json({ live, upcoming, completed: annotatedCompleted });
  } catch (e) {
    console.error(`[League:${req.params.slug}] getMatches:`, e.message);
    res.status(500).json({ error: "Failed to fetch matches" });
  }
}

async function getLive(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { live } = await leagueService.getLeagueMatches(withSeasonOverride(league, req));
    res.set("Cache-Control", "no-store");
    res.json({ live });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch live" });
  }
}

async function getUpcoming(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { upcoming } = await leagueService.getLeagueMatches(withSeasonOverride(league, req));
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.json({ upcoming });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch upcoming" });
  }
}

async function getResults(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const { completed } = await leagueService.getLeagueMatches(withSeasonOverride(league, req));
    res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.json({ completed });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch results" });
  }
}

async function getFixtures(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const fixtures = await leagueService.getLeagueFixtures(withSeasonOverride(league, req));
    res.set("Cache-Control", "public, max-age=600, stale-while-revalidate=3600");
    res.json({ fixtures });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch fixtures" });
  }
}

async function getTable(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    const table = await leagueService.getLeagueTable(withSeasonOverride(league, req));
    res.set("Cache-Control", "public, max-age=1800, stale-while-revalidate=7200");
    res.json({ table });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch standings" });
  }
}

async function getTeams(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json({ teams: await leagueService.getLeagueTeams(withSeasonOverride(league, req)), league });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch teams" });
  }
}

async function getHighlights(req, res) {
  const league = await resolve(req, res);
  if (!league) return;
  try {
    res.json({ highlights: await leagueService.getLeagueHighlights(withSeasonOverride(league, req)) });
  } catch (e) {
    res.status(500).json({ highlights: [] });
  }
}

module.exports = { listLeagues, getSeasons, getMatches, getLive, getUpcoming, getResults, getFixtures, getTable, getTeams, getHighlights };
