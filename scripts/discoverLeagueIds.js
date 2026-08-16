/**
 * discoverLeagueIds.js — One-time script to find Highlightly leagueIds for
 * all leagues used in leaguesConfig.js that aren't yet in highlightlyConfig.js.
 *
 * Run once after buying the ULTRA plan:
 *   node backend/scripts/discoverLeagueIds.js
 *
 * It will print the IDs to paste into highlightlyConfig.js.
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

// Leagues we want to find — { slug, searchName, currentYear }
const TARGETS = [
  { slug: "bbl",        searchName: "Big Bash",            years: [2025, 2026] },
  { slug: "psl",        searchName: "Pakistan Super",       years: [2025, 2026] },
  { slug: "bpl",        searchName: "Bangladesh Premier",   years: [2025, 2026] },
  { slug: "t20blast",   searchName: "T20 Blast",            years: [2025, 2026] },
  { slug: "t20wc",      searchName: "T20 World Cup",        years: [2024, 2026] },
  { slug: "wwct20",     searchName: "Women",                years: [2024, 2026] },
  { slug: "gsl",        searchName: "Global Super",         years: [2025, 2026] },
  { slug: "csa_t20",    searchName: "CSA T20",              years: [2025, 2026] },
  { slug: "supersmash", searchName: "Super Smash",          years: [2025, 2026] },
  { slug: "ashes",      searchName: "Ashes",                years: [2025, 2026] },
  { slug: "t20mumbai",  searchName: "T20 Mumbai",           years: [2025, 2026] },
  { slug: "iml",        searchName: "Masters League",       years: [2025, 2026] },
  { slug: "triseries",  searchName: "Tri",                  years: [2025, 2026] },
  { slug: "cpl",        searchName: "Caribbean Premier",    years: [2025, 2026] },
  { slug: "sa20",       searchName: "SA20",                 years: [2025, 2026] },
  { slug: "illt20",     searchName: "ILT20",                years: [2025, 2026] },
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(offset = 0) {
  const { data } = await http.get("/cricket/leagues", { params: { limit: 100, offset } });
  return data.data || [];
}

async function main() {
  console.log("Fetching all Highlightly cricket leagues…\n");

  const all = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage(offset);
    if (!page.length) break;
    all.push(...page);
    if (page.length < 100) break;
    offset += 100;
    await delay(300);
  }

  console.log(`Total leagues found: ${all.length}\n`);

  // Build a searchable index: name → { id, season }[]
  const byName = {};
  for (const l of all) {
    const name = (l.name || "").toLowerCase();
    if (!byName[name]) byName[name] = [];
    byName[name].push({ id: l.id, season: l.season, name: l.name });
  }

  console.log("=== MATCHES FOUND ===\n");
  const results = {};

  for (const target of TARGETS) {
    const needle = target.searchName.toLowerCase();
    const matches = all.filter(l => (l.name || "").toLowerCase().includes(needle));

    if (!matches.length) {
      console.log(`❌  ${target.slug}: NOT FOUND (searched "${target.searchName}")`);
      continue;
    }

    console.log(`✅  ${target.slug} (${target.searchName}):`);
    const seasons = {};
    for (const m of matches) {
      if (m.season && target.years.some(y => String(y) === String(m.season))) {
        seasons[m.season] = m.id;
      }
      console.log(`      ${m.id}  ${m.name}  season=${m.season}`);
    }
    results[target.slug] = seasons;
  }

  console.log("\n=== PASTE THIS INTO highlightlyConfig.js ===\n");
  for (const [slug, seasons] of Object.entries(results)) {
    if (!Object.keys(seasons).length) continue;
    const seasonsStr = Object.entries(seasons)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([y, id]) => `      ${y}: '${id}',`)
      .join("\n");
    console.log(`  ${slug}: {`);
    console.log(`    slug: '${slug}',`);
    console.log(`    currentSeason: ${Math.max(...Object.keys(seasons).map(Number))},`);
    console.log(`    seasons: {\n${seasonsStr}\n    },`);
    console.log(`  },`);
  }

}

main().catch(e => {
  console.error("Error:", e.response?.data || e.message);
  process.exit(1);
});
