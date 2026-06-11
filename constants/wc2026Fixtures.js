/**
 * wc2026Fixtures.js — FIFA World Cup 2026 hardcoded fixture schedule.
 *
 * Groups A-F: dates/times confirmed from the published FIFA schedule.
 * Groups G-L: estimated dates matching the rotation pattern.
 *
 * All times stored as UTC ISO strings; the normalizer converts to IST (+5:30).
 * Fixtures are pre-normalized FootballMatch objects — bypasses the API entirely.
 *
 * Status is computed at request time:
 *   "upcoming"  → utcTime in the future
 *   "live"      → within 105 min of utcTime (approximate, API provides real status once live)
 *   "completed" → more than 105 min past utcTime
 */

const { getTeam } = require("./wc2026Teams");

function makeTeam(code) {
  const t = getTeam(code);
  if (!t) throw new Error(`[WC2026Fixtures] Unknown team code: ${code}`);
  return { id: code, name: t.name, shortName: t.shortName, logo: "", flag: t.flag, color: t.color };
}

function toIST(utcISO) {
  const d   = new Date(utcISO);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const date = ist.toISOString().slice(0, 10);
  const h    = String(ist.getUTCHours()).padStart(2, "0");
  const m    = String(ist.getUTCMinutes()).padStart(2, "0");
  return { date, time: `${h}:${m} IST` };
}

function getStatus(utcISO) {
  const now    = Date.now();
  const start  = new Date(utcISO).getTime();
  const elapsed = now - start;
  if (elapsed < 0)                        return "upcoming";
  if (elapsed < 105 * 60 * 1000)         return "live";
  return "completed";
}

function match(id, homeCode, awayCode, utcISO, group, venue = "", city = "") {
  const { date, time } = toIST(utcISO);
  const status         = getStatus(utcISO);
  const isLive         = status === "live";
  const isCompleted    = status === "completed";

  return {
    id,
    homeTeam:   makeTeam(homeCode),
    awayTeam:   makeTeam(awayCode),
    score: {
      home:   isCompleted || isLive ? 0 : null,  // 0 placeholder; real score comes from API once live
      away:   isCompleted || isLive ? 0 : null,
      htHome: null,
      htAway: null,
    },
    status,
    statusText: isCompleted ? "FT" : isLive ? "LIVE" : "",
    minute:     null,
    venue,
    city,
    date,
    time,
    stage:      "Group Stage",
    group,
    sport:      "football",
    _hardcoded: true,       // flag so we know to refresh from API once live
  };
}

// ── Group Stage — Matchday 1 ──────────────────────────────────
// Groups A–F: confirmed times from FIFA schedule (UTC)
// Groups G–L: estimated times following the same daily rotation

const MATCHDAY_1 = [
  // ── Jun 11 (UTC) — Group A opens the tournament ──
  match("wc26_001", "MEX", "RSA",  "2026-06-11T19:00:00Z", "A"),
  match("wc26_002", "KOR", "CZE",  "2026-06-12T02:00:00Z", "A"),

  // ── Jun 12 (UTC) — Group B ──
  match("wc26_003", "CAN", "BIH",  "2026-06-12T19:00:00Z", "B"),
  match("wc26_004", "QAT", "SUI",  "2026-06-13T02:00:00Z", "B"),

  // ── Jun 13 (UTC) — Groups C & D ──
  match("wc26_005", "USA", "PAR",  "2026-06-13T01:00:00Z", "D"),
  match("wc26_006", "BRA", "MAR",  "2026-06-13T19:00:00Z", "C"),
  match("wc26_007", "HTI", "SCO",  "2026-06-13T22:00:00Z", "C"),
  match("wc26_008", "AUS", "TUR",  "2026-06-14T01:00:00Z", "D"),

  // ── Jun 14 (UTC) — Groups E & F ──
  match("wc26_009", "GER", "CUW",  "2026-06-14T17:00:00Z", "E"),
  match("wc26_010", "NED", "JPN",  "2026-06-14T20:00:00Z", "F"),
  match("wc26_011", "CIV", "ECU",  "2026-06-14T23:00:00Z", "E"),
  match("wc26_012", "SWE", "TUN",  "2026-06-15T02:00:00Z", "F"),

  // ── Jun 15 (UTC) — Groups G & H ──
  match("wc26_013", "ESP", "CPV",  "2026-06-15T16:00:00Z", "H"),
  match("wc26_014", "ARG", "NGA",  "2026-06-15T19:00:00Z", "G"),
  match("wc26_015", "BEL", "ALG",  "2026-06-15T22:00:00Z", "H"),
  match("wc26_016", "COL", "NZL",  "2026-06-16T02:00:00Z", "G"),

  // ── Jun 16 (UTC) — Groups I & J ──
  match("wc26_017", "FRA", "URU",  "2026-06-16T17:00:00Z", "I"),
  match("wc26_018", "ENG", "SEN",  "2026-06-16T20:00:00Z", "J"),
  match("wc26_019", "SAU", "SRB",  "2026-06-16T23:00:00Z", "I"),
  match("wc26_020", "IRN", "PAN",  "2026-06-17T02:00:00Z", "J"),

  // ── Jun 17 (UTC) — Groups K & L ──
  match("wc26_021", "POR", "IDN",  "2026-06-17T17:00:00Z", "K"),
  match("wc26_022", "ITA", "CMR",  "2026-06-17T20:00:00Z", "L"),
  match("wc26_023", "EGY", "HND",  "2026-06-17T23:00:00Z", "K"),
  match("wc26_024", "CRO", "SLV",  "2026-06-18T02:00:00Z", "L"),
];

// ── Group Stage — Matchday 2 ──────────────────────────────────
// Cross-pairings: team 1 vs team 4, team 2 vs team 3

const MATCHDAY_2 = [
  // Group A — Jun 19-20
  match("wc26_101", "MEX", "CZE",  "2026-06-19T17:00:00Z", "A"),
  match("wc26_102", "KOR", "RSA",  "2026-06-19T20:00:00Z", "A"),

  // Group B — Jun 19-20
  match("wc26_103", "CAN", "SUI",  "2026-06-19T23:00:00Z", "B"),
  match("wc26_104", "QAT", "BIH",  "2026-06-20T02:00:00Z", "B"),

  // Groups C & D — Jun 20-21
  match("wc26_105", "BRA", "SCO",  "2026-06-20T17:00:00Z", "C"),
  match("wc26_106", "MAR", "HTI",  "2026-06-20T20:00:00Z", "C"),
  match("wc26_107", "USA", "AUS",  "2026-06-20T23:00:00Z", "D"),
  match("wc26_108", "PAR", "TUR",  "2026-06-21T02:00:00Z", "D"),

  // Groups E & F — Jun 21-22
  match("wc26_109", "GER", "ECU",  "2026-06-21T17:00:00Z", "E"),
  match("wc26_110", "CIV", "CUW",  "2026-06-21T20:00:00Z", "E"),
  match("wc26_111", "NED", "TUN",  "2026-06-21T23:00:00Z", "F"),
  match("wc26_112", "JPN", "SWE",  "2026-06-22T02:00:00Z", "F"),

  // Groups G & H — Jun 22-23
  match("wc26_113", "ARG", "COL",  "2026-06-22T17:00:00Z", "G"),
  match("wc26_114", "NGA", "NZL",  "2026-06-22T20:00:00Z", "G"),
  match("wc26_115", "ESP", "BEL",  "2026-06-22T23:00:00Z", "H"),
  match("wc26_116", "CPV", "ALG",  "2026-06-23T02:00:00Z", "H"),

  // Groups I & J — Jun 23-24
  match("wc26_117", "FRA", "SRB",  "2026-06-23T17:00:00Z", "I"),
  match("wc26_118", "SAU", "URU",  "2026-06-23T20:00:00Z", "I"),
  match("wc26_119", "ENG", "IRN",  "2026-06-23T23:00:00Z", "J"),
  match("wc26_120", "SEN", "PAN",  "2026-06-24T02:00:00Z", "J"),

  // Groups K & L — Jun 24-25
  match("wc26_121", "POR", "HND",  "2026-06-24T17:00:00Z", "K"),
  match("wc26_122", "IDN", "EGY",  "2026-06-24T20:00:00Z", "K"),
  match("wc26_123", "ITA", "SLV",  "2026-06-24T23:00:00Z", "L"),
  match("wc26_124", "CRO", "CMR",  "2026-06-25T02:00:00Z", "L"),
];

// ── Group Stage — Matchday 3 (decisive — same-group pairs simultaneous) ──

const MATCHDAY_3 = [
  // Group A — Jun 25 (simultaneous kicks)
  match("wc26_201", "MEX", "KOR",  "2026-06-25T17:00:00Z", "A"),
  match("wc26_202", "RSA", "CZE",  "2026-06-25T17:00:00Z", "A"),

  // Group B — Jun 25
  match("wc26_203", "CAN", "QAT",  "2026-06-25T21:00:00Z", "B"),
  match("wc26_204", "BIH", "SUI",  "2026-06-25T21:00:00Z", "B"),

  // Group C — Jun 26
  match("wc26_205", "BRA", "HTI",  "2026-06-26T17:00:00Z", "C"),
  match("wc26_206", "MAR", "SCO",  "2026-06-26T17:00:00Z", "C"),

  // Group D — Jun 26
  match("wc26_207", "USA", "TUR",  "2026-06-26T21:00:00Z", "D"),
  match("wc26_208", "AUS", "PAR",  "2026-06-26T21:00:00Z", "D"),

  // Group E — Jun 27
  match("wc26_209", "GER", "CIV",  "2026-06-27T17:00:00Z", "E"),
  match("wc26_210", "ECU", "CUW",  "2026-06-27T17:00:00Z", "E"),

  // Group F — Jun 27
  match("wc26_211", "NED", "SWE",  "2026-06-27T21:00:00Z", "F"),
  match("wc26_212", "JPN", "TUN",  "2026-06-27T21:00:00Z", "F"),

  // Group G — Jun 28
  match("wc26_213", "ARG", "NZL",  "2026-06-28T17:00:00Z", "G"),
  match("wc26_214", "COL", "NGA",  "2026-06-28T17:00:00Z", "G"),

  // Group H — Jun 28
  match("wc26_215", "ESP", "ALG",  "2026-06-28T21:00:00Z", "H"),
  match("wc26_216", "BEL", "CPV",  "2026-06-28T21:00:00Z", "H"),

  // Group I — Jun 29
  match("wc26_217", "FRA", "SAU",  "2026-06-29T17:00:00Z", "I"),
  match("wc26_218", "URU", "SRB",  "2026-06-29T17:00:00Z", "I"),

  // Group J — Jun 29
  match("wc26_219", "ENG", "PAN",  "2026-06-29T21:00:00Z", "J"),
  match("wc26_220", "SEN", "IRN",  "2026-06-29T21:00:00Z", "J"),

  // Group K — Jun 30
  match("wc26_221", "POR", "EGY",  "2026-06-30T17:00:00Z", "K"),
  match("wc26_222", "HND", "IDN",  "2026-06-30T17:00:00Z", "K"),

  // Group L — Jun 30
  match("wc26_223", "ITA", "CRO",  "2026-06-30T21:00:00Z", "L"),
  match("wc26_224", "CMR", "SLV",  "2026-06-30T21:00:00Z", "L"),
];

// ── All group stage fixtures combined ────────────────────────────
const ALL_FIXTURES = [...MATCHDAY_1, ...MATCHDAY_2, ...MATCHDAY_3];

module.exports = { ALL_FIXTURES, MATCHDAY_1, MATCHDAY_2, MATCHDAY_3 };
