/**
 * predictionService.js — CricketIQ pre-match score predictions.
 *
 * Algorithm (priority order):
 *   1. Historical vs-opponent average (ipl_player_vs_team) — if ≥20 balls faced
 *   2. Career IPL average (ipl_player_batting) — if ≥15 innings
 *   3. Position curve + role multiplier (fallback for new/unknown players)
 *
 * Final predicted runs = blend of (1)/(2) + position anchor + SR multiplier.
 * Fully deterministic for the same matchId — safe to cache.
 */

const supabase                   = require("../config/supabase");
const { getCachedData, setCachedData } = require("./dbService");

// ── Role normaliser ───────────────────────────────────────────

function normaliseRole(raw = "") {
  const r = raw.toLowerCase().replace(/[^a-z-]/g, "");
  if (r.includes("wicket") || r === "wk" || r === "wkbat") return "WK-BAT";
  if (r.includes("allrounder") || r === "all" || r === "ar") return "ALL";
  if (r.includes("bowl") || r === "bol")                    return "BOL";
  if (r.includes("bat") || r === "bat")                     return "BAT";
  return "ALL";
}

// ── Position curve (T20, positions 0–10) ─────────────────────

const POSITION_RUNS = [44, 38, 32, 28, 22, 18, 14, 10, 7, 5, 3];

const ROLE_ORDER = { "BAT": 0, "WK-BAT": 0, "WK": 1, "ALL": 2, "BOL": 3 };

const ROLE_MULTIPLIER = {
  "BAT": 1.00, "WK-BAT": 0.98, "WK": 0.90, "ALL": 0.82, "BOL": 0.48,
};

// ── Helpers ───────────────────────────────────────────────────

function seededVariance(matchId, name, range) {
  const str = `${matchId}:${name}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return (h % (range * 2 + 1)) - range;
}

function sortByBattingOrder(players) {
  return [...players]
    .sort((a, b) => {
      const ra = ROLE_ORDER[normaliseRole(a.role)] ?? 2;
      const rb = ROLE_ORDER[normaliseRole(b.role)] ?? 2;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    })
    .map((p, idx) => ({ ...p, position: idx }));
}

// ── Historical data lookup ────────────────────────────────────

async function fetchCareerStats(playerNames) {
  if (!playerNames.length) return {};
  try {
    const { data, error } = await supabase
      .from("ipl_player_batting")
      .select("player, innings, runs, balls, dismissals, average, strike_rate")
      .in("player", playerNames);
    if (error || !data) return {};
    const map = {};
    for (const r of data) map[r.player] = r;
    return map;
  } catch { return {}; }
}

async function fetchVsTeamStats(playerNames, vsTeam) {
  if (!playerNames.length || !vsTeam) return {};
  try {
    const { data, error } = await supabase
      .from("ipl_player_vs_team")
      .select("player, batter_runs, batter_balls, batter_dismissals")
      .in("player", playerNames)
      .eq("vs_team", vsTeam);
    if (error || !data) return {};
    const map = {};
    for (const r of data) map[r.player] = r;
    return map;
  } catch { return {}; }
}

// ── Per-player run prediction ─────────────────────────────────

function predictRuns(matchId, player, careerStats, vsTeamStats) {
  const role     = normaliseRole(player.role);
  const pos      = Math.min(player.position, POSITION_RUNS.length - 1);
  const posBase  = POSITION_RUNS[pos] * (ROLE_MULTIPLIER[role] ?? 0.80);

  // If bowler, skip historical lookup — just use position curve
  if (role === "BOL") {
    const variance = seededVariance(matchId, player.name, 2);
    return Math.max(1, Math.round(posBase + variance));
  }

  const career  = careerStats[player.name];
  const vsTeam  = vsTeamStats[player.name];

  let baseRuns  = posBase;
  let hasHist   = false;

  // Prefer vs-team average (≥20 balls faced)
  if (vsTeam && vsTeam.batter_balls >= 20) {
    const vsAvg = vsTeam.batter_dismissals > 0
      ? vsTeam.batter_runs / vsTeam.batter_dismissals
      : vsTeam.batter_runs / Math.max(1, vsTeam.batter_balls / 18); // approximate innings from balls
    // Blend with career if available, else use vs-team directly
    if (career && career.innings >= 15) {
      baseRuns = 0.50 * vsAvg + 0.30 * career.average + 0.20 * posBase;
    } else {
      baseRuns = 0.65 * vsAvg + 0.35 * posBase;
    }
    hasHist = true;
  } else if (career && career.innings >= 15) {
    // Use career average blended with position anchor
    const srBoost = career.strike_rate > 0 ? (career.strike_rate / 135) : 1.0; // 135 = baseline T20 SR
    baseRuns = (0.65 * career.average + 0.35 * posBase) * Math.min(1.25, Math.max(0.80, srBoost));
    hasHist = true;
  }

  const range    = Math.max(3, Math.floor(baseRuns * (hasHist ? 0.15 : 0.18)));
  const variance = seededVariance(matchId, player.name, range);
  return Math.max(1, Math.round(baseRuns + variance));
}

// ── Main export ───────────────────────────────────────────────

async function getPredictions(matchId, team1Info, team2Info, team1Players, team2Players) {
  const cacheKey = `pred:${matchId}`;

  const cached = await getCachedData(cacheKey, 7 * 24 * 60 * 60_000);
  if (cached) {
    const hasPlayers = (cached.team1?.length ?? 0) + (cached.team2?.length ?? 0) > 0;
    if (hasPlayers) {
      console.log(`[Pred] cache hit: ${matchId}`);
      return cached;
    }
    console.log(`[Pred] stale empty cache for ${matchId} — regenerating`);
  }

  const t1Players = sortByBattingOrder(team1Players ?? []);
  const t2Players = sortByBattingOrder(team2Players ?? []);

  const allNames = [...t1Players, ...t2Players].map(p => p.name);

  // Fetch historical stats in parallel
  const [careerMap, t1VsT2Map, t2VsT1Map] = await Promise.all([
    fetchCareerStats(allNames),
    fetchVsTeamStats(t1Players.map(p => p.name), team2Info?.shortName),
    fetchVsTeamStats(t2Players.map(p => p.name), team1Info?.shortName),
  ]);

  const result = {
    matchId,
    team1Short: team1Info?.shortName ?? "T1",
    team2Short: team2Info?.shortName ?? "T2",
    team1: t1Players.map(p => ({
      name:          p.name,
      role:          normaliseRole(p.role),
      position:      p.position,
      predictedRuns: predictRuns(matchId, p, careerMap, t1VsT2Map),
    })),
    team2: t2Players.map(p => ({
      name:          p.name,
      role:          normaliseRole(p.role),
      position:      p.position,
      predictedRuns: predictRuns(matchId, p, careerMap, t2VsT1Map),
    })),
  };

  await setCachedData(cacheKey, result);
  console.log(`[Pred] generated for match ${matchId}`);
  return result;
}

module.exports = { getPredictions };
