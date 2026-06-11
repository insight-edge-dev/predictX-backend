/**
 * wwct20HistoryService.js — Historical ICC Women's T20 World Cup data (2014–2023)
 * loaded from a local CSV dump (backend/data/T20WWC/ICC_Cup_Data.csv, 112 matches
 * across 5 tournaments). Used by genericTipsService to ground wwct20 predictions
 * in real cross-tournament results — team win-rates and head-to-head records —
 * instead of the seededVariance placeholder that otherwise applies to nearly every
 * match (current-season data is empty/sparse for a quadrennial tournament).
 *
 * Sportsmonks display names follow the pattern "{Country} W" (e.g. "Australia W");
 * the CSV uses bare country names ("Australia") — fullNameFromDisplay() bridges them.
 */

const fs   = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "..", "data", "T20WWC", "ICC_Cup_Data.csv");

let cache = null; // { teams: Map<fullName, {played,wins,losses,noResult}>, h2h: Map<"A|B", {teams:[a,b],aWins,bWins,noResult}> }

// Minimal CSV parser — handles quoted fields with embedded commas/quotes (RFC 4180).
// No library dependency needed for a 112-row file read once at startup.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function pairKey(a, b) { return [a, b].sort().join("|"); }

function load() {
  if (cache) return cache;

  const teams = new Map();
  const h2h   = new Map();
  const bump  = (name) => {
    if (!teams.has(name)) teams.set(name, { played: 0, wins: 0, losses: 0, noResult: 0 });
    return teams.get(name);
  };

  try {
    const text   = fs.readFileSync(CSV_PATH, "utf-8");
    const rows   = parseCsv(text);
    const header = rows[0];
    const idx    = Object.fromEntries(header.map((h, i) => [h.trim(), i]));

    for (const r of rows.slice(1)) {
      const t1     = r[idx["Team 1"]]?.trim();
      const t2     = r[idx["Team 2"]]?.trim();
      const winner = r[idx["winner"]]?.trim();
      const loser  = r[idx["loser"]]?.trim();
      const wasRes = r[idx["was result?"]]?.trim();
      if (!t1 || !t2) continue;

      bump(t1).played++;
      bump(t2).played++;

      const k = pairKey(t1, t2);
      if (!h2h.has(k)) h2h.set(k, { teams: [t1, t2].sort(), aWins: 0, bWins: 0, noResult: 0 });
      const rec = h2h.get(k);

      const noResult = !winner || wasRes === "False";
      if (noResult) {
        bump(t1).noResult++;
        bump(t2).noResult++;
        rec.noResult++;
      } else if (winner && loser) {
        bump(winner).wins++;
        bump(loser).losses++;
        if (rec.teams[0] === winner) rec.aWins++; else rec.bWins++;
      }
    }
  } catch (e) {
    console.warn("[WWCT20History] failed to load CSV —", e.message);
  }

  cache = { teams, h2h };
  return cache;
}

// Sportsmonks display names are "{Country} W" (e.g. "Australia W", "South Africa W");
// the historical CSV uses bare country names.
function fullNameFromDisplay(displayName) {
  return (displayName || "").replace(/\s+W$/i, "").trim();
}

// Overall 2014-2023 record for a team, keyed by its live Sportsmonks display name.
// Returns null when the team has no historical WWCT20 appearances in the dataset
// (e.g. Scotland, Netherlands — recent qualifiers not present in 2014-2023 data).
function getTeamRecord(displayName) {
  const { teams } = load();
  const rec = teams.get(fullNameFromDisplay(displayName));
  if (!rec || rec.played === 0) return null;
  const decided = rec.wins + rec.losses;
  return { ...rec, winPct: decided > 0 ? rec.wins / decided : 0.5 };
}

// Cross-tournament head-to-head between two teams (2014-2023), keyed by live display names.
function getH2H(displayA, displayB) {
  const { h2h } = load();
  const a = fullNameFromDisplay(displayA);
  const b = fullNameFromDisplay(displayB);
  const rec = h2h.get(pairKey(a, b));
  if (!rec) return null;

  const aIsFirst = rec.teams[0] === a;
  const aWins = aIsFirst ? rec.aWins : rec.bWins;
  const bWins = aIsFirst ? rec.bWins : rec.aWins;
  return { total: aWins + bWins + rec.noResult, aWins, bWins, noResult: rec.noResult };
}

module.exports = { getTeamRecord, getH2H, fullNameFromDisplay };
