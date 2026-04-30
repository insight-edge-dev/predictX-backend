/**
 * sportmonksNormalizer.js — converts raw Sportsmonks responses into the
 * app's internal data shapes (same contracts as the old CricketData normalizer).
 *
 * Pure functions — no I/O, no side-effects, never throws.
 *
 * Sportsmonks fixture statuses:
 *   NS          → upcoming   (Not Started)
 *   Inprogress  → live
 *   Finished    → completed
 *   Abandoned / Cancelled / Rained Out / No Result → completed (no result)
 *   Stumps / Innings Break / Lunch / Tea / Dinner  → live
 *
 * Scorecard innings are keyed by scoreboard field: S1 = 1st innings, S2 = 2nd.
 *
 * IPL team IDs (Sportsmonks):
 *   CSK=2  DC=3  PBKS=4  KKR=5  MI=6  RR=7  RCB=8  SRH=9  GT=1976  LSG=1979
 */

const { toISTTime, formatMatchDate } = require("../utils/timeUtils");
const { normalizeIPLTeam, getIPLLogo } = require("../constants/iplTeams");

// ── Status mapping ────────────────────────────────────────────

const LIVE_STATUSES = new Set([
  "Inprogress", "Innings Break", "Stumps", "Lunch", "Tea", "Dinner",
  "Strategic Break", "Rain Delay",
]);

const FINISHED_STATUSES = new Set([
  "Finished", "Completed",
]);

const NO_RESULT_STATUSES = new Set([
  "Abandoned", "Aban.", "Cancelled", "Rained Out", "No Result",
]);

function fixtureStatus(raw) {
  // draw_noresult flag overrides everything — match has concluded with no result
  if (raw.draw_noresult) return "completed";
  if (raw.live === true && LIVE_STATUSES.has(raw.status)) return "live";
  if (LIVE_STATUSES.has(raw.status))    return "live";
  if (FINISHED_STATUSES.has(raw.status)) return "completed";
  if (NO_RESULT_STATUSES.has(raw.status)) return "completed";
  if (raw.status === "NS")               return "upcoming";
  // fallback: if live flag is set, treat as live
  if (raw.live === true)                 return "live";
  return "upcoming";
}

// ── Stage → matchStage label ──────────────────────────────────

function descToStage(round) {
  const r = (round || "").toLowerCase();
  if (r.includes("final"))       return "FINAL";
  if (r.includes("qualifier"))   return "QUALIFIER";
  if (r.includes("eliminator"))  return "ELIMINATOR";
  if (r.includes("semi"))        return "SEMI FINAL";
  return "LEAGUE";
}

// ── Team object builder ───────────────────────────────────────

function buildTeam(raw) {
  if (!raw) return { id: "", name: "", shortName: "", logo: "" };
  const shortName = normalizeIPLTeam(raw.name) || raw.code || "";
  return {
    id:        raw.id,
    name:      raw.name  || "",
    shortName,
    logo:      getIPLLogo(shortName) || raw.image_path || "",
  };
}

// ── Score extraction from runs[] ──────────────────────────────

function buildScores(runs, localteamId, visitorteamId) {
  let score1 = null, score2 = null, overs1 = null, overs2 = null;

  if (!Array.isArray(runs)) return { score1, score2, overs1, overs2 };

  // Sort by inning so we always pick 1st inning first for each team
  const sorted = [...runs].sort((a, b) => a.inning - b.inning);

  for (const r of sorted) {
    const scoreStr = r.wickets != null ? `${r.score}/${r.wickets}` : String(r.score);
    const oversStr = r.overs != null ? String(r.overs) : null;

    if (r.team_id === localteamId && score1 === null) {
      score1 = scoreStr; overs1 = oversStr;
    } else if (r.team_id === visitorteamId && score2 === null) {
      score2 = scoreStr; overs2 = oversStr;
    }
  }

  return { score1, score2, overs1, overs2 };
}

// ── Note sanitization ─────────────────────────────────────────
// Sportsmonks note field sometimes has garbled text like
// "Royal Challengers won by 6Bengaluru  wickets" (missing space).

function _cleanNote(note) {
  if (!note) return "";
  return note
    .replace(/(\d)([A-Z])/g, "$1 $2")   // "6Bengaluru" → "6 Bengaluru"
    .replace(/\s{2,}/g, " ")             // collapse double spaces
    .trim();
}

// ── Time formatter for upcoming match statusText ──────────────
// Converts "2026-04-07T14:00:00.000000Z" → "Apr 07, 07:30 PM IST"

function _formatMatchTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      month: "short",
      day:   "2-digit",
    });
    const time = d.toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour:     "2-digit",
      minute:   "2-digit",
      hour12:   true,
    });
    return `${date}, ${time} IST`;
  } catch {
    return iso;
  }
}

// ── normalizeFixture ──────────────────────────────────────────
// Converts a Sportsmonks fixture object (with localteam/visitorteam/runs)
// into the standard match shape used across the app.

function normalizeFixture(raw) {
  if (!raw || !raw.id) return null;

  try {
    const team1 = buildTeam(raw.localteam);
    const team2 = buildTeam(raw.visitorteam);
    const { score1, score2, overs1, overs2 } = buildScores(
      raw.runs,
      raw.localteam_id,
      raw.visitorteam_id,
    );

    const status     = fixtureStatus(raw);
    const statusText = raw.note
      ? _cleanNote(raw.note)
      : (status === "upcoming" ? `Match starts at ${_formatMatchTime(raw.starting_at)}` : "");
    const venue      = raw.venue?.name || "";
    const date       = raw.starting_at || null;

    // Toss
    let toss = null;
    if (raw.toss_won_team_id) {
      const tossTeam = raw.toss_won_team_id === raw.localteam_id ? team1 : team2;
      toss = {
        winner:   tossTeam.name,
        decision: raw.elected || "",
      };
    }

    // Winner
    let winner = null;
    if (raw.winner_team_id) {
      winner = raw.winner_team_id === raw.localteam_id ? team1.name : team2.name;
    } else if (raw.draw_noresult) {
      winner = "No Result";
    }

    return {
      id:          raw.id,
      team1,
      team2,
      score1,
      score2,
      overs1,
      overs2,
      status,
      statusText,
      venue,
      series:      "Indian Premier League 2026",
      seriesId:    String(raw.season_id || ""),
      date,
      time:        date ? toISTTime(date) : "",
      matchType:   (raw.type || "t20").toLowerCase(),
      matchDesc:   raw.round || "",
      matchStage:  descToStage(raw.round),
      toss,
      winner,
    };
  } catch (e) {
    console.warn("[SMNorm] normalizeFixture failed:", raw.id, e.message);
    return null;
  }
}

// ── normalizeScorecard ────────────────────────────────────────
// Builds innings array from fixture batting[], bowling[], scoreboards[], runs[].
// Sportsmonks groups by scoreboard field: "S1" = 1st innings, "S2" = 2nd, etc.

function normalizeScorecard(fixture) {
  if (!fixture) return null;

  const batting    = Array.isArray(fixture.batting)    ? fixture.batting    : [];
  const bowling    = Array.isArray(fixture.bowling)    ? fixture.bowling    : [];
  const scoreboards = Array.isArray(fixture.scoreboards) ? fixture.scoreboards : [];
  const runs       = Array.isArray(fixture.runs)       ? fixture.runs       : [];

  if (batting.length === 0 && bowling.length === 0) return null;

  // Discover innings slots in order (S1, S2, S3, S4)
  const slots = [...new Set([
    ...batting.map(b => b.scoreboard),
    ...bowling.map(b => b.scoreboard),
  ])].sort(); // S1 < S2 < S3 < S4

  if (slots.length === 0) return null;

  // Build player-name lookup from batsman/bowler includes
  const playerMap = {};
  for (const b of batting)  { if (b.batsman) playerMap[b.player_id] = b.batsman.fullname; }
  for (const b of bowling)  { if (b.bowler)  playerMap[b.player_id] = b.bowler.fullname; }

  return slots.map(slot => {
    const slotBat  = batting.filter(b  => b.scoreboard === slot).sort((a, b) => a.sort - b.sort);
    const slotBowl = bowling.filter(bw => bw.scoreboard === slot);

    // Determine batting team: most bat entries share a team_id
    const batTeamId = slotBat[0]?.team_id ?? null;
    const bowlTeamId = slotBowl[0]?.team_id ?? null;

    // Inning label
    const slotNum   = parseInt(slot.replace("S", ""), 10);
    const batTeam   = batTeamId === fixture.localteam_id
      ? (fixture.localteam?.code || "T1")
      : (fixture.visitorteam?.code || "T2");
    const inningLabel = `${batTeam} Inning ${slotNum}`;

    // ── Batting ───────────────────────────────────────
    const batsmen = slotBat.map(b => {
      const name    = playerMap[b.player_id] || `Player ${b.player_id}`;
      const isNotOut = b.wicket_id === null || b.active === true;
      return {
        id:          String(b.player_id),
        name,
        runs:        b.score     ?? 0,
        balls:       b.ball      ?? 0,
        fours:       b.four_x    ?? 0,
        sixes:       b.six_x     ?? 0,
        strikeRate:  b.rate      ?? 0,
        dismissal:   isNotOut ? "" : _buildDismissal(b, playerMap),
        isNotOut,
        isCaptain:   false,
        isKeeper:    false,
      };
    });

    // ── Bowling ───────────────────────────────────────
    const bowlers = slotBowl.map(bw => ({
      id:      String(bw.player_id),
      name:    playerMap[bw.player_id] || `Player ${bw.player_id}`,
      overs:   bw.overs   ?? 0,
      maidens: bw.medians ?? 0,
      runs:    bw.runs    ?? 0,
      wickets: bw.wickets ?? 0,
      economy: bw.rate    ?? 0,
    }));

    // ── Extras ────────────────────────────────────────
    const extrasRow = scoreboards.find(s => s.scoreboard === slot && s.type === "extra" && s.team_id === batTeamId);
    const extras = {
      runs: extrasRow
        ? (extrasRow.wide ?? 0) + (extrasRow.noball_runs ?? 0) + (extrasRow.bye ?? 0) + (extrasRow.leg_bye ?? 0)
        : 0,
      nb:  extrasRow?.noball_runs ?? 0,
      wd:  extrasRow?.wide        ?? 0,
      lb:  extrasRow?.leg_bye     ?? 0,
      b:   extrasRow?.bye         ?? 0,
    };

    // ── Total ─────────────────────────────────────────
    const totalRow  = scoreboards.find(s => s.scoreboard === slot && s.type === "total" && s.team_id === batTeamId);
    // Also try runs[] as fallback
    const runsEntry = runs.find(r => r.team_id === batTeamId && r.inning === slotNum);
    const total = {
      runs:    totalRow?.total   ?? runsEntry?.score   ?? 0,
      wickets: totalRow?.wickets ?? runsEntry?.wickets ?? 0,
      overs:   String(totalRow?.overs ?? runsEntry?.overs ?? ""),
    };

    // ── Fall of Wickets ───────────────────────────────
    const fow = slotBat
      .filter(b => b.fow_score != null && b.wicket_id != null)
      .sort((a, b) => a.fow_score - b.fow_score)
      .map(b => ({
        player: playerMap[b.player_id] || "",
        runs:   b.fow_score ?? 0,
        over:   b.fow_balls != null ? String(b.fow_balls) : "",
      }));

    return {
      inning:   inningLabel,
      batsmen,
      bowlers,
      extras,
      total,
      yetToBat: [],
      fow,
    };
  });
}

// Build a short dismissal string from available IDs + playerMap
function _buildDismissal(b, playerMap) {
  if (b.runout_by_id) {
    const by = playerMap[b.runout_by_id] || "";
    return by ? `run out (${by})` : "run out";
  }
  const bowler  = playerMap[b.bowling_player_id]   || "";
  const fielder = playerMap[b.catch_stump_player_id] || "";
  if (fielder && bowler) return `c ${fielder} b ${bowler}`;
  if (bowler)            return `b ${bowler}`;
  return "out";
}

// ── normalizeSquadPlayers ─────────────────────────────────────
// Converts a Sportsmonks squad[] (from /teams/{id}/squad/{season})
// into the app's player array shape.

function normalizeSquadPlayers(squad) {
  if (!Array.isArray(squad)) return [];
  return squad.map(p => ({
    id:            String(p.id),
    name:          p.fullname || `${p.firstname || ""} ${p.lastname || ""}`.trim(),
    role:          _mapPosition(p.position?.name),
    battingStyle:  p.battingstyle  || "",
    bowlingStyle:  p.bowlingstyle  || "",
    image:         p.image_path    || "",
    isCaptain:     false,
    isKeeper:      p.position?.name === "Wicketkeeper",
  }));
}

function _mapPosition(pos) {
  if (!pos) return "ALL";
  const p = pos.toLowerCase();
  if (p.includes("wicket"))    return "WK-BAT";
  if (p.includes("allrounder") || p.includes("all-rounder")) return "ALL";
  if (p.includes("bowl"))      return "BOL";
  if (p.includes("bat"))       return "BAT";
  return "ALL";
}

// ── normalizeStandings ────────────────────────────────────────
// Converts Sportsmonks standings rows into the app's points-table shape.

function normalizeStandings(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  return rows
    .map(row => {
      const team      = Array.isArray(row.team) ? row.team[0] : row.team;
      const name      = team?.name  || "";
      const code      = team?.code  || "";
      const shortName = normalizeIPLTeam(name) || code;
      const logo      = getIPLLogo(shortName)  || team?.image_path || "";

      const nrr = Number(row.netto_run_rate ?? 0);

      return {
        teamName:  name,
        teamShort: shortName,
        logo,
        played:    row.played    ?? 0,
        wins:      row.won       ?? 0,
        losses:    row.lost      ?? 0,
        nrr:       parseFloat(nrr.toFixed(3)),
        points:    row.points    ?? 0,
        last5:     _parseForm(row.recent_form),
      };
    })
    .sort((a, b) => b.points - a.points || b.nrr - a.nrr);
}

function _parseForm(form) {
  if (!Array.isArray(form)) return [];
  return form.slice(0, 5).map(c => {
    const u = String(c).toUpperCase();
    if (u === "W") return "W";
    if (u === "L") return "L";
    return "N";
  });
}

// ── normalizePlayer ───────────────────────────────────────────

function normalizePlayerSummary(raw) {
  if (!raw) return null;
  return {
    id:      raw.id,
    name:    raw.fullname || `${raw.firstname || ""} ${raw.lastname || ""}`.trim(),
    country: raw.country?.name || raw.nationality || "",
    role:    _mapPosition(raw.position?.name),
    logo:    raw.image_path || "",
  };
}

function normalizePlayerProfile(raw) {
  if (!raw) return null;
  return {
    id:           raw.id,
    name:         raw.fullname || `${raw.firstname || ""} ${raw.lastname || ""}`.trim(),
    country:      raw.country?.name || "",
    dateOfBirth:  raw.dateofbirth || "",
    role:         _mapPosition(raw.position?.name),
    battingStyle: raw.battingstyle  || "",
    bowlingStyle: raw.bowlingstyle  || "",
    logo:         raw.image_path    || "",
    bio:          "",
    stats: {
      batting: {
        matches: 0, innings: 0, runs: 0, highScore: "0",
        average: 0, strikeRate: 0, hundreds: 0, fifties: 0,
      },
      bowling: {
        matches: 0, innings: 0, wickets: 0, bestFigures: "0/0",
        average: 0, economy: 0, strikeRate: 0,
      },
    },
  };
}

// ── normalizeRankings ─────────────────────────────────────────
// Sportsmonks /team-rankings returns by type (TEST/ODI/T20).
// We extract the T20 type for home screen.

function normalizeRankings(raw) {
  if (!Array.isArray(raw)) return { batsmen: [], bowlers: [], teams: [] };

  const t20Entry = raw.find(r => r.type === "T20");
  if (!t20Entry) return { batsmen: [], bowlers: [], teams: [] };

  const teams = (Array.isArray(t20Entry.team) ? t20Entry.team : [])
    .slice(0, 8)
    .map(t => ({
      id:      String(t.id),
      rank:    t.ranking?.position ?? t.position ?? 0,
      name:    t.name   || "",
      rating:  t.ranking?.rating  ?? 0,
      matches: t.ranking?.matches ?? 0,
      points:  t.ranking?.points  ?? 0,
    }));

  return { batsmen: [], bowlers: [], teams };
}

module.exports = {
  normalizeFixture,
  normalizeScorecard,
  normalizeSquadPlayers,
  normalizeStandings,
  normalizePlayerSummary,
  normalizePlayerProfile,
  normalizeRankings,
};
