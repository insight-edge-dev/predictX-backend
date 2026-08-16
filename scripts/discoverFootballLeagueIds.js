/**
 * discoverFootballLeagueIds.js — Find Highlightly leagueIds for football leagues.
 *
 * Football IDs in Highlightly are STATIC (same id across all seasons),
 * unlike cricket where each season gets a new id.
 *
 * Run:
 *   node backend/scripts/discoverFootballLeagueIds.js
 *
 * Prints the id to paste into HL_FOOTBALL_LEAGUES in highlightlyConfig.js.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const axios = require("axios");

const BASE_URL = "https://sports.highlightly.net";
const API_KEY  = process.env.HIGHLIGHTLY_API_KEY;

if (!API_KEY) {
  console.error("HIGHLIGHTLY_API_KEY not set in backend/.env");
  process.exit(1);
}

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { "x-rapidapi-key": API_KEY },
});

// Leagues to discover — { slug, searchName, country }
const TARGETS = [
  // Already configured (for reference / id verification)
  { slug: "isl",               searchName: "Indian Super",          country: "IN",   configured: true },
  { slug: "laliga",            searchName: "La Liga",               country: "ES",   configured: true },
  { slug: "premier_league",    searchName: "Premier League",        country: "GB",   configured: true },
  { slug: "ucl",               searchName: "Champions League",      country: "INTL", configured: true },
  { slug: "bundesliga",        searchName: "Bundesliga",            country: "DE",   configured: true },
  { slug: "ligue1",            searchName: "Ligue 1",               country: "FR",   configured: true },
  { slug: "uel",               searchName: "Europa League",         country: "INTL", configured: true },

  // New leagues to add
  { slug: "serie_a",           searchName: "Serie A",               country: "IT" },
  { slug: "eredivisie",        searchName: "Eredivisie",            country: "NL" },
  { slug: "liga_portugal",     searchName: "Primeira Liga",         country: "PT" },
  { slug: "super_lig",         searchName: "Super Lig",             country: "TR" },
  { slug: "saudi_pro",         searchName: "Saudi Pro League",      country: "SA" },
  { slug: "mls",               searchName: "Major League Soccer",   country: "US" },
  { slug: "j_league",          searchName: "J1 League",             country: "JP" },
  { slug: "k_league",          searchName: "K League 1",            country: "KR" },
  { slug: "a_league",          searchName: "A-League",              country: "AU" },
  { slug: "i_league",          searchName: "I-League",              country: "IN" },
  { slug: "uecl",              searchName: "Conference League",     country: "INTL" },
  { slug: "fa_cup",            searchName: "FA Cup",                country: "GB" },
  { slug: "carabao_cup",       searchName: "Carabao Cup",           country: "GB" },
  { slug: "copa_del_rey",      searchName: "Copa del Rey",          country: "ES" },
  { slug: "dfb_pokal",         searchName: "DFB Pokal",             country: "DE" },
  { slug: "coppa_italia",      searchName: "Coppa Italia",          country: "IT" },
  { slug: "afc_cl",            searchName: "AFC Champions",         country: "INTL" },
  { slug: "copa_america",      searchName: "Copa America",          country: "INTL" },
  { slug: "euro",              searchName: "UEFA Euro",             country: "INTL" },
  { slug: "afcon",             searchName: "Africa Cup",            country: "INTL" },
  { slug: "afc_asian_cup",     searchName: "Asian Cup",             country: "INTL" },
  { slug: "ligue2",            searchName: "Ligue 2",               country: "FR" },
  { slug: "championship",      searchName: "Championship",          country: "GB" },
  { slug: "segunda",           searchName: "Segunda",               country: "ES" },
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchFootballLeague(searchName) {
  try {
    const { data } = await http.get("/football/leagues", {
      params: { leagueName: searchName, limit: 20 },
    });
    return data.data || [];
  } catch (e) {
    console.warn(`  Search failed for "${searchName}": ${e.response?.data?.message || e.message}`);
    return [];
  }
}

async function main() {
  console.log("Discovering Highlightly football league IDs…\n");
  console.log("(Football IDs are STATIC — same ID every season unlike cricket)\n");

  const results = [];

  for (const target of TARGETS) {
    const prefix = target.configured ? "🔵 (existing)" : "🆕";
    process.stdout.write(`${prefix} ${target.slug}… `);

    const matches = await searchFootballLeague(target.searchName);

    if (!matches.length) {
      console.log(`NOT FOUND (searched "${target.searchName}")`);
      results.push({ ...target, id: null, matches: [] });
    } else {
      const byCountry = target.country !== "INTL"
        ? matches.filter(m => (m.country?.code || m.countryCode || "").toUpperCase() === target.country)
        : matches;

      const best = byCountry[0] || matches[0];
      console.log(`✅  id=${best.id}  "${best.name}"  country=${best.country?.name || best.countryCode || "?"}`);

      if (matches.length > 1) {
        matches.slice(1).forEach(m =>
          console.log(`           also: id=${m.id}  "${m.name}"  country=${m.country?.name || m.countryCode || "?"}`),
        );
      }

      results.push({ ...target, id: best.id, bestMatch: best, allMatches: matches });
    }

    await delay(400);
  }

  // ── Print config blocks ───────────────────────────────────────
  console.log("\n\n=== PASTE INTO HL_FOOTBALL_LEAGUES in highlightlyConfig.js ===\n");

  const newLeagues = results.filter(r => !r.configured && r.id);
  for (const r of newLeagues) {
    console.log(`  ${r.slug}: {`);
    console.log(`    slug: '${r.slug}', name: '${r.bestMatch?.name || r.searchName}', short: '${r.bestMatch?.name?.split(" ").map(w => w[0]).join("") || r.slug.toUpperCase()}',`);
    console.log(`    country: '${r.country}', id: '${r.id}', currentSeason: 2026,`);
    console.log(`    seasons: [2024, 2025, 2026],`);
    console.log(`  },`);
  }

  const notFound = results.filter(r => !r.configured && !r.id);
  if (notFound.length) {
    console.log("\n=== NOT FOUND ===");
    notFound.forEach(r => console.log(`  ${r.slug} ("${r.searchName}")`));
  }
}

main().catch(e => {
  console.error("Error:", e.response?.data || e.message);
  process.exit(1);
});
