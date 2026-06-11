/**
 * wcHistoryLoader.js — FIFA World Cup historical data (1970–2022).
 *
 * Parses backend/data/FIFAWC/fifa_wc_mens_match_dataset_1970_2022.csv
 * at module load time and exports:
 *   getTeamProfile(code)  → historical WC stats per team
 *   getH2H(codeA, codeB) → WC head-to-head record between two teams
 *
 * Team codes are normalised to the 3-letter shortNames used in API-Football
 * (e.g. dataset "DEU" → "GER", "CHE" → "SUI").  Both directions are
 * supported — API codes are also mapped to dataset codes for lookup.
 *
 * Recency weighting:
 *   2014–2022 (last 3 tournaments):  ×1.5
 *   2002–2010:                        ×1.2
 *   Pre-2002:                         ×1.0
 */

const fs   = require("fs");
const path = require("path");

// ── ISO-3166 / dataset code  →  API-Football shortName ───────────
// Dataset uses ISO codes for some nations that API-Football labels differently.
const DATASET_TO_API = {
  DEU: "GER",  CHE: "SUI",  HRV: "CRO",  PRT: "POR",
  DNK: "DEN",  NLD: "NED",  URY: "URU",  CHL: "CHI",
  ZAF: "RSA",  PRT: "POR",  CSK: "CZE",  DDR: "GER",
  SCG: "SRB",  SUN: "RUS",  YUG: "SRB",  CRI: "CRC",
  CIV: "CIV",  CMR: "CMR",  DZA: "ALG",  TTO: "TRI",
};
// Reverse map — API code → dataset code
const API_TO_DATASET = Object.fromEntries(
  Object.entries(DATASET_TO_API).map(([d, a]) => [a, d])
);

function toApiCode(datasetCode) {
  return DATASET_TO_API[datasetCode] ?? datasetCode;
}
function toDatasetCode(apiCode) {
  return API_TO_DATASET[apiCode] ?? apiCode;
}

// ── Recency weight by year ────────────────────────────────────────
function recencyWeight(year) {
  if (year >= 2014) return 1.5;
  if (year >= 2002) return 1.2;
  return 1.0;
}

// ── Quoted-CSV parser (handles "Washington, D.C." style fields) ──
function parseCSV(text) {
  const rows    = [];
  const lines   = text.split(/\r?\n/);
  const headers = splitCSVLine(lines[0]);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = splitCSVLine(line);
    if (vals.length !== headers.length) continue; // skip malformed
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j]; });
    rows.push(row);
  }
  return rows;
}

function splitCSVLine(line) {
  const fields = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// ── Load and parse CSV ────────────────────────────────────────────

const CSV_PATH = path.join(__dirname, "../data/FIFAWC/fifa_wc_mens_match_dataset_1970_2022.csv");

let _raw = [];

try {
  const text = fs.readFileSync(CSV_PATH, "utf8");
  _raw = parseCSV(text);
  console.log(`[WCHistory] loaded ${_raw.length} match rows from 1970–2022 WC dataset`);
} catch (e) {
  console.error("[WCHistory] failed to load dataset:", e.message);
}

// ── Build team profiles ───────────────────────────────────────────

const _profiles = new Map();   // apiCode → profile
const _h2h      = new Map();   // "CODEA:CODEB" (sorted) → record

function _key(a, b) {
  return [a, b].sort().join(":");
}

for (const row of _raw) {
  const dataCode   = row.team_code;
  if (!dataCode || dataCode.includes(" ")) continue; // skip malformed rows

  const apiCode    = toApiCode(dataCode);
  const year       = parseInt(row.match_date?.slice(0, 4) ?? "0", 10);
  const wt         = recencyWeight(year);
  const isKnockout = row.knockout_stage === "1";
  const isHost     = row.is_host       === "1";
  const outcome    = (row.outcome || "").toLowerCase(); // "win", "loss", "draw"
  const isPenalty  = row.penalty_shootout === "1";
  const goalsFor   = parseFloat(row.goals_for)     || 0;
  const goalsCon   = parseFloat(row.goals_against) || 0;
  const validMatch = outcome === "win" || outcome === "loss" || outcome === "draw";
  if (!validMatch) continue;

  // ── Team profile accumulation ─────────────────────────────────
  if (!_profiles.has(apiCode)) {
    _profiles.set(apiCode, {
      code: apiCode,
      name: row.team_name ?? dataCode,
      raw: { wt: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0,
             koWt: 0, koWins: 0, koMatches: 0,
             penWins: 0, penMatches: 0,
             hostWt: 0, hostWins: 0, hostMatches: 0,
             appearances: new Set() },
    });
  }
  const p = _profiles.get(apiCode).raw;

  p.wt     += wt;
  p.gf     += goalsFor * wt;
  p.ga     += goalsCon * wt;
  if (outcome === "win")  p.wins  += wt;
  if (outcome === "draw") p.draws += wt;
  if (outcome === "loss") p.losses += wt;

  if (isKnockout) {
    p.koWt      += wt;
    p.koMatches += 1;
    if (outcome === "win") p.koWins += wt;
  }

  if (isPenalty) {
    p.penMatches += 1;
    if (outcome === "win") p.penWins += 1;
  }

  if (isHost) {
    p.hostWt      += wt;
    p.hostMatches += 1;
    if (outcome === "win") p.hostWins += wt;
  }

  p.appearances.add(row.tournament_name);

  // ── H2H accumulation ──────────────────────────────────────────
  const oppDataCode = row.opponent_code;
  if (!oppDataCode || oppDataCode.includes(" ")) continue;
  const oppApiCode  = toApiCode(oppDataCode);
  const hKey        = _key(apiCode, oppApiCode);
  const teamIsFirst = [apiCode, oppApiCode].sort()[0] === apiCode;

  if (!_h2h.has(hKey)) {
    _h2h.set(hKey, { a: 0, b: 0, draws: 0, aGF: 0, aGA: 0, total: 0 });
  }
  const h = _h2h.get(hKey);
  h.total += 1;

  if (teamIsFirst) {
    h.aGF += goalsFor;
    h.aGA += goalsCon;
    if (outcome === "win")  h.a++;
    if (outcome === "draw") h.draws++;
  } else {
    if (outcome === "win")  h.b++;
  }
}

// ── Finalise profiles ─────────────────────────────────────────────

function finalizeProfile(code) {
  const p = _profiles.get(code);
  if (!p) return null;
  const r = p.raw;
  const wtTotal = r.wt;

  return {
    code:                p.code,
    name:                p.name,
    appearances:         r.appearances.size,
    wcWinRate:           wtTotal > 0 ? r.wins / wtTotal : 0.5,
    wcDrawRate:          wtTotal > 0 ? r.draws / wtTotal : 0.25,
    wcGoalsForAvg:       wtTotal > 0 ? r.gf / wtTotal : 1.0,
    wcGoalsAgainstAvg:   wtTotal > 0 ? r.ga / wtTotal : 1.0,
    wcGoalDiffAvg:       wtTotal > 0 ? (r.gf - r.ga) / wtTotal : 0,
    wcKnockoutWinRate:   r.koWt  > 0 ? r.koWins / r.koWt  : null, // null = no KO data
    wcPenaltyWinRate:    r.penMatches > 0 ? r.penWins / r.penMatches : null,
    hostWinRate:         r.hostMatches > 0 ? r.hostWins / r.hostWt  : null,
  };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Returns compiled historical WC profile for a team.
 * Accepts both API shortNames ("GER") and dataset ISO codes ("DEU").
 * Returns null if team has no WC history.
 */
function getTeamProfile(code) {
  const apiCode = toApiCode(code.toUpperCase());
  if (_profiles.has(apiCode)) return finalizeProfile(apiCode);
  if (_profiles.has(code.toUpperCase())) return finalizeProfile(code.toUpperCase());
  return null;
}

/**
 * Returns WC head-to-head record between two teams.
 * aCode/bCode: API shortNames or dataset codes.
 * Returns { total, aWins, bWins, draws, aGoalsAvg, bGoalsAvg, aWinRate }.
 * Returns null if no WC meetings.
 */
function getH2H(aCode, bCode) {
  const a = toApiCode(aCode.toUpperCase());
  const b = toApiCode(bCode.toUpperCase());
  const k = _key(a, b);
  if (!_h2h.has(k)) return null;
  const h = _h2h.get(k);

  const decided = h.a + h.b;
  const aIsFirst = [a, b].sort()[0] === a;
  const aWins    = aIsFirst ? h.a : h.b;
  const bWins    = aIsFirst ? h.b : h.a;

  // Each match produces 2 rows (both perspectives) — deduplicate
  const actualMatches = Math.round(h.total / 2);
  const actualAWins   = Math.round(aWins / 2);
  const actualBWins   = Math.round(bWins / 2);
  const actualDraws   = Math.round(h.draws / 2);

  const actualDecided = actualAWins + actualBWins;

  return {
    total:     actualMatches,
    aWins:     actualAWins,
    bWins:     actualBWins,
    draws:     actualDraws,
    aGoalsAvg: actualMatches > 0 ? (aIsFirst ? h.aGF : h.aGA) / actualMatches : 0,
    bGoalsAvg: actualMatches > 0 ? (aIsFirst ? h.aGA : h.aGF) / actualMatches : 0,
    aWinRate:  actualDecided > 0 ? actualAWins / actualDecided : 0.5,
  };
}

/**
 * List all teams with WC history (sorted by appearances desc).
 */
function getAllTeams() {
  return Array.from(_profiles.keys())
    .map(c => finalizeProfile(c))
    .filter(Boolean)
    .sort((a, b) => b.appearances - a.appearances);
}

// ── WC title counts (historical facts, not in dataset) ────────────
const WC_TITLES = {
  BRA: 5, GER: 4, ITA: 4, ARG: 3, FRA: 2, URY: 2,
  ENG: 1, ESP: 1,
};

// Classic rivalry pairs to surface
const RIVALRY_PAIRS = [
  ['BRA', 'ARG'], ['BRA', 'GER'], ['BRA', 'ITA'],
  ['ARG', 'GER'], ['ARG', 'ENG'], ['FRA', 'GER'],
];

/**
 * Returns pre-computed WC stats for the football home screen.
 * All computation is synchronous — result should be cached by the caller.
 */
function getWCStats() {
  const allTeams = getAllTeams();

  // Top nations — min 5 appearances, sorted by titles then win rate
  const legends = allTeams
    .filter(t => t.appearances >= 5)
    .map(t => ({
      code:               t.code,
      name:               t.name,
      titles:             WC_TITLES[t.code] ?? 0,
      appearances:        t.appearances,
      wcWinRate:          Math.round(t.wcWinRate * 100),
      wcKnockoutWinRate:  t.wcKnockoutWinRate !== null ? Math.round(t.wcKnockoutWinRate * 100) : null,
      wcGoalDiffAvg:      parseFloat(t.wcGoalDiffAvg.toFixed(2)),
    }))
    .sort((a, b) => (b.titles - a.titles) || (b.wcWinRate - a.wcWinRate))
    .slice(0, 8);

  // Penalty records — min 2 shootouts
  const penTeams = allTeams
    .filter(t => {
      const raw = _profiles.get(t.code)?.raw;
      return raw && raw.penMatches >= 2 && t.wcPenaltyWinRate !== null;
    })
    .map(t => ({
      code:             t.code,
      name:             t.name,
      penaltyWinRate:   Math.round(t.wcPenaltyWinRate * 100),
      penaltyMatches:   _profiles.get(t.code).raw.penMatches,
    }));

  const penaltyBest  = [...penTeams].sort((a, b) => b.penaltyWinRate - a.penaltyWinRate).slice(0, 4);
  const penaltyWorst = [...penTeams].sort((a, b) => a.penaltyWinRate - b.penaltyWinRate).slice(0, 3);

  // Classic rivalries
  const rivalries = RIVALRY_PAIRS
    .map(([a, b]) => {
      const h2h  = getH2H(a, b);
      if (!h2h || h2h.total === 0) return null;
      const profA = finalizeProfile(a);
      const profB = finalizeProfile(b);
      return {
        teamA: { code: a, name: profA?.name ?? a },
        teamB: { code: b, name: profB?.name ?? b },
        total: h2h.total,
        aWins: h2h.aWins,
        bWins: h2h.bWins,
        draws: h2h.draws,
      };
    })
    .filter(Boolean);

  // Overall host nation win rate
  let totalHostWt = 0, totalHostWins = 0;
  for (const [code] of _profiles) {
    const raw = _profiles.get(code).raw;
    totalHostWt   += raw.hostWt;
    totalHostWins += raw.hostWins;
  }

  return {
    legends,
    penaltyBest,
    penaltyWorst,
    rivalries,
    hostWinRate: totalHostWt > 0 ? Math.round((totalHostWins / totalHostWt) * 100) : null,
    dataAsOf: '2022',
  };
}

module.exports = { getTeamProfile, getH2H, getAllTeams, getWCStats, hasData: _raw.length > 0 };
