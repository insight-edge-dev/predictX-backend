/**
 * footballPredictionService.js — WC 2026 3-way prediction engine.
 *
 * Six factors, all backed by 1970–2022 World Cup historical data:
 *
 * GROUP STAGE
 *   1. WC Historical Win Rate (recency-weighted)      25%
 *   2. WC Head-to-Head at World Cups                  20%
 *   3. Current Tournament Form (API-Football live)    25%
 *   4. FIFA Ranking                                   15%
 *   5. WC Goals Quality (GF avg – GA avg)             10%
 *   6. Host-nation advantage                           5%
 *
 * KNOCKOUT STAGE  (same slots, adjusted weights)
 *   1. WC Knockout Win Rate (dedicated KO rate)       30%
 *   2. WC Head-to-Head                                20%
 *   3. Current Tournament Form                        25%
 *   4. FIFA Ranking                                   10%
 *   5. WC Goals Quality                               10%
 *   6. Host + Penalty Record                           5%
 *
 * Draw probability: present only in group stage, derived from how
 * evenly matched the two sides are.  Knockouts → draw = 0.
 *
 * Teams with no WC history get a neutral 0.5 on all WC factors
 * and rely on ranking + live form.
 */

const wcHistory = require("./wcHistoryLoader");
const { getCache, setCache, TTL, KEYS } = require("./cacheService");

// ── Placeholder guard ─────────────────────────────────────────────
function isPlaceholderTeam(team) {
  const name = (team?.shortName || team?.name || "").toUpperCase();
  return name === "TBD" || name === "TBC";
}

// ── FIFA WC 2026 ranking table ────────────────────────────────────
// Normalised 0–1 (rank 1 → 1.0).  Unlisted teams default to 0.28.
const FIFA_RANKS = {
  ARG: 1,  FRA: 2,  ENG: 3,  BRA: 4,  BEL: 5,
  POR: 6,  ESP: 7,  NED: 8,  ITA: 9,  CRO: 10,
  URU: 11, GER: 12, MEX: 13, USA: 14, COL: 15,
  MAR: 16, SEN: 17, DEN: 18, SUI: 19, JPN: 20,
  KOR: 21, AUS: 22, CAN: 23, ECU: 24, GHA: 25,
  CMR: 26, TUN: 27, NGA: 28, POL: 29, SRB: 30,
  CRC: 31, IRN: 32, SAU: 33, QAT: 34, PAN: 35,
  NZL: 36, MAL: 37, HND: 38, TRI: 39, CIV: 40,
  EGY: 41, RSA: 42, SLV: 43, CUB: 44, VEN: 45,
  BOL: 46, PER: 47, CHI: 48, WAL: 49, SCO: 50,
};
const MAX_RANK = 50;

function rankScore(code) {
  const rank = FIFA_RANKS[(code || "").toUpperCase()];
  if (!rank) return 0.28;
  return 1 - (rank - 1) / MAX_RANK;
}

// ── Seeded variance (deterministic noise, prevents 50/50 ties) ───
function seededVariance(seed, range) {
  let h = 5381;
  for (let i = 0; i < seed.length; i++)
    h = (Math.imul(h, 33) ^ seed.charCodeAt(i)) >>> 0;
  return (h % (range * 2 + 1)) - range;
}

// ── Form string → normalised score ───────────────────────────────
// Parses a form string like "WWDLW" from API-Football standings.
function parseForm(form) {
  if (!form) return 0.5;
  const chars = form.toUpperCase().slice(-5).split("");
  let pts = 0;
  chars.forEach(c => { if (c === "W") pts += 3; else if (c === "D") pts += 1; });
  const max = chars.length * 3;
  return max > 0 ? pts / max : 0.5;
}

// ── Pair normalisation (two raw scores → each as fraction of sum) ─
function pairNorm(a, b) {
  const t = a + b;
  return t > 0 ? [a / t, b / t] : [0.5, 0.5];
}

// ── Factor helper ─────────────────────────────────────────────────
function factor(label, homeVal, awayVal, homeScore, awayScore) {
  const adv = homeScore > awayScore + 0.03 ? "home"
            : awayScore > homeScore + 0.03 ? "away"
            : "neutral";
  return { label, homeValue: String(homeVal), awayValue: String(awayVal), advantage: adv };
}

// ── Confidence label ──────────────────────────────────────────────
function confLabel(pct) {
  if (pct >= 62) return "HIGH";
  if (pct >= 52) return "MEDIUM";
  return "LOW";
}

// ── Core prediction ───────────────────────────────────────────────

async function buildPrediction(match) {
  const homeName  = match.homeTeam?.shortName ?? match.homeTeam?.name ?? "";
  const awayName  = match.awayTeam?.shortName ?? match.awayTeam?.name ?? "";
  const isKO      = match.stage !== "Group Stage";

  const homeRawGoals = match.homeTeam?.goalsFor      ?? 0;
  const awayRawGoals = match.awayTeam?.goalsFor      ?? 0;
  const homeRawConc  = match.homeTeam?.goalsAgainst  ?? 0;
  const awayRawConc  = match.awayTeam?.goalsAgainst  ?? 0;
  const homeRawPlayed= match.homeTeam?.played        ?? 0;
  const awayRawPlayed= match.awayTeam?.played        ?? 0;
  const homeIsHost   = match.homeTeam?.isHost        ?? false;

  // ── WC historical profiles ─────────────────────────────────────
  const homeProf = wcHistory.getTeamProfile(homeName);
  const awayProf = wcHistory.getTeamProfile(awayName);
  const hasHistory = !!(homeProf && awayProf);

  // ── F1: WC Historical Win Rate ─────────────────────────────────
  const homeWCRate = isKO
    ? (homeProf?.wcKnockoutWinRate ?? homeProf?.wcWinRate ?? 0.4)
    : (homeProf?.wcWinRate ?? 0.4);
  const awayWCRate = isKO
    ? (awayProf?.wcKnockoutWinRate ?? awayProf?.wcWinRate ?? 0.4)
    : (awayProf?.wcWinRate ?? 0.4);
  const [wcHomeNorm, wcAwayNorm] = pairNorm(homeWCRate, awayWCRate);

  // ── F2: WC Head-to-Head ────────────────────────────────────────
  const h2hRecord = wcHistory.getH2H(homeName, awayName);
  let h2hHome = 0.5, h2hAway = 0.5;
  const hasH2H = h2hRecord && h2hRecord.total >= 1;
  if (hasH2H) {
    h2hHome = h2hRecord.aWinRate;          // home team is always "a" per getH2H contract
    h2hAway = 1 - h2hRecord.aWinRate;
    // Shrink toward 0.5 when H2H sample is tiny (1–2 meetings)
    const shrink = Math.min(1, h2hRecord.total / 4);
    h2hHome = 0.5 + (h2hHome - 0.5) * shrink;
    h2hAway = 0.5 + (h2hAway - 0.5) * shrink;
  }

  // ── F3: Current Tournament Form ───────────────────────────────
  // Priority: live API form string → live goals data → WC pre-match curr_form
  const homeFormStr = match.homeTeam?.form ?? "";
  const awayFormStr = match.awayTeam?.form ?? "";
  let homeFormScore = parseForm(homeFormStr);
  let awayFormScore = parseForm(awayFormStr);

  // If no form string, derive from goals data in current tournament
  if (!homeFormStr && homeRawPlayed > 0) {
    const homeGDperGame = (homeRawGoals - homeRawConc) / homeRawPlayed;
    homeFormScore = Math.max(0.1, Math.min(0.9, 0.5 + homeGDperGame * 0.12));
  }
  if (!awayFormStr && awayRawPlayed > 0) {
    const awayGDperGame = (awayRawGoals - awayRawConc) / awayRawPlayed;
    awayFormScore = Math.max(0.1, Math.min(0.9, 0.5 + awayGDperGame * 0.12));
  }
  const [formHome, formAway] = pairNorm(homeFormScore, awayFormScore);

  // ── F4: FIFA Ranking ───────────────────────────────────────────
  const homeRank = rankScore(homeName);
  const awayRank = rankScore(awayName);
  const [rankHome, rankAway] = pairNorm(homeRank, awayRank);

  // ── F5: WC Goals Quality (attack – defence index) ─────────────
  const homeGQ = homeProf
    ? Math.max(0.05, 0.5 + (homeProf.wcGoalsForAvg - homeProf.wcGoalsAgainstAvg) * 0.15)
    : 0.5;
  const awayGQ = awayProf
    ? Math.max(0.05, 0.5 + (awayProf.wcGoalsForAvg - awayProf.wcGoalsAgainstAvg) * 0.15)
    : 0.5;
  const [gqHome, gqAway] = pairNorm(homeGQ, awayGQ);

  // ── F6: Host advantage + Penalty record (KO only) ─────────────
  let hostHome = 0.5, hostAway = 0.5;
  if (homeIsHost) {
    // 59.7% historical host win rate from dataset
    hostHome = 0.597;
    hostAway = 0.403;
  } else if (!homeIsHost && (match.awayTeam?.isHost)) {
    hostHome = 0.403;
    hostAway = 0.597;
  }
  // In knockouts, weight penalty record into F6
  if (isKO) {
    const homePenRate = homeProf?.wcPenaltyWinRate ?? 0.5;
    const awayPenRate = awayProf?.wcPenaltyWinRate ?? 0.5;
    const [penHome, penAway] = pairNorm(homePenRate, awayPenRate);
    // Blend host factor (50%) with penalty factor (50%) for KO F6
    hostHome = (hostHome + penHome) / 2;
    hostAway = (hostAway + penAway) / 2;
  }

  // ── Weighted composite ─────────────────────────────────────────
  let homeScore, awayScore;
  if (isKO) {
    homeScore = wcHomeNorm * 0.30 + h2hHome  * 0.20 + formHome * 0.25
              + rankHome  * 0.10 + gqHome    * 0.10 + hostHome * 0.05;
    awayScore = wcAwayNorm * 0.30 + h2hAway  * 0.20 + formAway * 0.25
              + rankAway  * 0.10 + gqAway    * 0.10 + hostAway * 0.05;
  } else {
    homeScore = wcHomeNorm * 0.25 + h2hHome  * 0.20 + formHome * 0.25
              + rankHome  * 0.15 + gqHome    * 0.10 + hostHome * 0.05;
    awayScore = wcAwayNorm * 0.25 + h2hAway  * 0.20 + formAway * 0.25
              + rankAway  * 0.15 + gqAway    * 0.10 + hostAway * 0.05;
  }

  // ── Deterministic seeded variance (breaks 0.5/0.5 ties) ────────
  const seed     = `${match.id}:${homeName}:${awayName}`;
  const homeAdj  = homeScore + seededVariance(seed + ":h", 3) / 100;
  const awayAdj  = awayScore + seededVariance(seed + ":a", 3) / 100;

  // ── Draw probability (group stage only) ───────────────────────
  const diff      = Math.abs(homeAdj - awayAdj);
  // Historical WC draw rate: ~19%.  Peaks when teams are very even.
  const baseDraw  = isKO ? 0 : 0.22;
  const drawProb  = isKO ? 0 : Math.max(0, baseDraw - diff * 2.2);
  const remainder = 1 - drawProb;
  const adjTotal  = homeAdj + awayAdj;
  let homeWin  = (homeAdj / adjTotal) * remainder;
  let awayWin  = (awayAdj / adjTotal) * remainder;

  // Normalise to 100 %
  const total = homeWin + drawProb + awayWin;
  homeWin = Math.round((homeWin / total) * 100);
  awayWin = Math.round((awayWin / total) * 100);
  const draw = 100 - homeWin - awayWin;

  // ── Winner ────────────────────────────────────────────────────
  let winner = null;
  if (homeWin > awayWin && homeWin > draw) winner = match.homeTeam?.name ?? homeName;
  else if (awayWin > homeWin && awayWin > draw) winner = match.awayTeam?.name ?? awayName;

  const confidence = Math.max(homeWin, draw, awayWin);

  // ── Factor descriptions ───────────────────────────────────────
  const rankA = FIFA_RANKS[homeName.toUpperCase()] ?? "–";
  const rankB = FIFA_RANKS[awayName.toUpperCase()] ?? "–";

  const wcRateLabel = isKO ? "WC Knockout Win Rate" : "WC Historical Win Rate";
  const homeWCPct   = (homeWCRate * 100).toFixed(0) + "% at WCs";
  const awayWCPct   = (awayWCRate * 100).toFixed(0) + "% at WCs";

  const h2hLabel = hasH2H
    ? `${h2hRecord.aWins}W–${h2hRecord.draws}D–${h2hRecord.bWins}L`
    : "No WC meetings";
  const h2hLabelAway = hasH2H
    ? `${h2hRecord.bWins}W–${h2hRecord.draws}D–${h2hRecord.aWins}L`
    : "No WC meetings";

  const gqLabelHome = homeProf
    ? `${homeProf.wcGoalsForAvg.toFixed(1)} GF / ${homeProf.wcGoalsAgainstAvg.toFixed(1)} GA`
    : "No WC data";
  const gqLabelAway = awayProf
    ? `${awayProf.wcGoalsForAvg.toFixed(1)} GF / ${awayProf.wcGoalsAgainstAvg.toFixed(1)} GA`
    : "No WC data";

  const penLabelHome = homeProf?.wcPenaltyWinRate != null
    ? (homeProf.wcPenaltyWinRate * 100).toFixed(0) + "% pen WR"
    : "No pen data";
  const penLabelAway = awayProf?.wcPenaltyWinRate != null
    ? (awayProf.wcPenaltyWinRate * 100).toFixed(0) + "% pen WR"
    : "No pen data";

  const factors = [
    factor(wcRateLabel,             homeWCPct,  awayWCPct,  wcHomeNorm, wcAwayNorm),
    factor("WC Head-to-Head",       h2hLabel,   h2hLabelAway, h2hHome, h2hAway),
    factor("Tournament Form",       homeFormStr.slice(-5) || "–", awayFormStr.slice(-5) || "–", formHome, formAway),
    factor("FIFA Ranking",          `#${rankA}`, `#${rankB}`,  rankHome, rankAway),
    factor("WC Scoring Quality",    gqLabelHome, gqLabelAway,  gqHome, gqAway),
    isKO
      ? factor("KO Pressure / Penalty Record", penLabelHome, penLabelAway, ...pairNorm(homeProf?.wcPenaltyWinRate ?? 0.5, awayProf?.wcPenaltyWinRate ?? 0.5))
      : factor("Host Advantage", homeIsHost ? "Host nation" : "Away side", homeIsHost ? "Away side" : (match.awayTeam?.isHost ? "Host nation" : "Neutral"), hostHome, hostAway),
  ];

  // ── H2H summary for detail panel ─────────────────────────────
  const h2hData = {
    total:      h2hRecord?.total ?? 0,
    homeWins:   h2hRecord?.aWins ?? 0,
    awayWins:   h2hRecord?.bWins ?? 0,
    draws:      h2hRecord?.draws ?? 0,
    homeWinPct: hasH2H ? Math.round(h2hRecord.aWinRate * 100) : 50,
    awayWinPct: hasH2H ? Math.round((1 - h2hRecord.aWinRate) * 100) : 50,
    recentResults: [],
  };

  return {
    matchId:         match.id,
    homeTeam:        homeName,
    awayTeam:        awayName,
    homeWin,
    draw,
    awayWin,
    winner,
    confidence,
    confidenceLabel: confLabel(confidence),
    factors,
    h2hData,
    recentForm: {
      home: homeFormStr.slice(-5).split("").map(c => ({ result: c })),
      away: awayFormStr.slice(-5).split("").map(c => ({ result: c })),
    },
    isKnockout:     isKO,
    dataQuality:    hasHistory ? "full" : "partial",
    historyNote:    !hasHistory ? "Limited WC history — ranking-based prediction" : null,
  };
}

// ── Public API ────────────────────────────────────────────────────

async function getMatchPrediction(match) {
  if (isPlaceholderTeam(match.homeTeam) || isPlaceholderTeam(match.awayTeam)) return null;

  const key = KEYS.FOOTBALL_TIP(match.id);
  const hot = getCache(key);
  if (hot) return hot;

  const prediction = await buildPrediction(match);
  setCache(key, prediction, TTL.FOOTBALL_TIP);
  return prediction;
}

async function getLightweightPrediction(match) {
  const full = await getMatchPrediction(match);
  if (!full) return null;
  return {
    matchId:         full.matchId,
    homeWin:         full.homeWin,
    draw:            full.draw,
    awayWin:         full.awayWin,
    winner:          full.winner,
    confidence:      full.confidence,
    confidenceLabel: full.confidenceLabel,
    isKnockout:      full.isKnockout,
    dataQuality:     full.dataQuality,
  };
}

module.exports = { getMatchPrediction, getLightweightPrediction };
