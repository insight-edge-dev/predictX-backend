/**
 * highlightlyNormalizer.js — Maps Highlightly API responses into the app's
 * internal data shapes (same contracts the frontend and controllers expect).
 *
 * Pure functions — no I/O, no side-effects, never throws (all errors caught).
 *
 * Highlightly status descriptions:
 *   'Scheduled'     → upcoming
 *   'Not Started'   → upcoming
 *   'In play'       → live
 *   'Innings Break' → live
 *   'Lunch' / 'Tea' / 'Dinner' / 'Strategic Break' → live
 *   'Stumps'        → live (day's play ended — match continues tomorrow)
 *   'Rain Delay'    → live
 *   'Finished'      → completed
 *   'Abandoned'     → completed (no result)
 *   'Cancelled'     → completed (no result)
 *   'No live coverage' → skip (not tracked)
 */

// ── Status mapping ────────────────────────────────────────────

const LIVE_DESC = new Set([
  "In play", "Innings Break", "Lunch", "Tea", "Dinner",
  "Strategic Break", "Rain Delay", "Stumps",
]);
const FINISHED_DESC  = new Set(["Finished", "Completed"]);
const NO_RESULT_DESC = new Set(["Abandoned", "Cancelled", "No Result"]);

function _status(desc) {
  if (!desc) return "upcoming";
  if (LIVE_DESC.has(desc))     return "live";
  if (FINISHED_DESC.has(desc)) return "completed";
  if (NO_RESULT_DESC.has(desc)) return "completed";
  return "upcoming";
}

// ── Time formatter ────────────────────────────────────────────

function _formatMatchTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata", month: "short", day: "2-digit",
    });
    const time = d.toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
    });
    return `${date}, ${time} IST`;
  } catch {
    return iso;
  }
}

// ── Team builder ──────────────────────────────────────────────

function _team(raw) {
  if (!raw) return { id: "", name: "", shortName: "", logo: "" };
  let shortName = raw.abbreviation || raw.shortName || "";
  if (!shortName && raw.name) {
    const words = raw.name.split(/\s+/).filter(Boolean);
    // Multi-word: initials (e.g. "Real Madrid" → "RM")
    // Single-word: first 3 chars uppercase (e.g. "Fenerbahçe" → "FEN")
    shortName = words.length > 1
      ? words.map(w => w[0].toUpperCase()).join("")
      : raw.name.slice(0, 3).toUpperCase();
  }
  return {
    id:        String(raw.id || ""),
    name:      raw.name || "",
    shortName,
    // Highlightly uses 'image' in fixture list, 'logo' in team detail — try both
    logo:      raw.logo || raw.image || raw.imageUrl || raw.imagePath || raw.crest || "",
  };
}

// ── Winner extraction from result text ────────────────────────

function _extractWinner(report, homeTeam, awayTeam) {
  if (!report) return null;
  if (/no result|abandoned|cancelled|called off/i.test(report)) return "No Result";
  const r = report.toLowerCase();
  if (homeTeam.name && r.includes(homeTeam.name.toLowerCase()) && /won/i.test(report)) return homeTeam.name;
  if (awayTeam.name && r.includes(awayTeam.name.toLowerCase()) && /won/i.test(report)) return awayTeam.name;
  if (homeTeam.shortName && r.includes(homeTeam.shortName.toLowerCase()) && /won/i.test(report)) return homeTeam.name;
  if (awayTeam.shortName && r.includes(awayTeam.shortName.toLowerCase()) && /won/i.test(report)) return awayTeam.name;
  return null;
}

// ── Match stage from round/context ───────────────────────────

function _stage(raw) {
  const ctx = (raw.round || raw.league?.name || "").toLowerCase();
  if (ctx.includes("final"))      return "FINAL";
  if (ctx.includes("semi"))       return "SEMI FINAL";
  if (ctx.includes("qualifier"))  return "QUALIFIER";
  if (ctx.includes("eliminator")) return "ELIMINATOR";
  return "LEAGUE";
}

// ── normalizeFixture ──────────────────────────────────────────
// Converts a Highlightly match object into the app's standard match shape.

function normalizeFixture(raw) {
  if (!raw?.id) return null;
  try {
    const home = _team(raw.homeTeam);
    const away = _team(raw.awayTeam);
    const desc   = raw.state?.description || "";
    const status = _status(desc);
    const report = raw.state?.report      || "";

    let statusText = "";
    if (status === "completed")       statusText = report;
    else if (status === "upcoming")   statusText = `Match starts at ${_formatMatchTime(raw.startTime || raw.startDate)}`;
    else                              statusText = desc;

    const winner = (status === "completed") ? _extractWinner(report, home, away) : null;

    return {
      id:          String(raw.id),
      date:        raw.startTime || raw.startDate || null,
      // team1 = home, team2 = away (matches Sportsmonks convention in controllers)
      team1:       home,
      team2:       away,
      score1:      raw.state?.teams?.home?.score || null,
      score2:      raw.state?.teams?.away?.score || null,
      overs1:      raw.state?.teams?.home?.info  || null,
      overs2:      raw.state?.teams?.away?.info  || null,
      status,
      statusText,
      venue:       raw.venue?.name || "",
      venueCity:   raw.venue?.city || "",
      toss:        raw.toss
        ? { winner: raw.toss.winner || null, decision: raw.toss.decision || null }
        : null,
      winner,
      seriesLabel: `${raw.league?.name || ""} ${raw.league?.season || ""}`.trim(),
      matchDesc:   raw.round || '',
      matchStage:  _stage(raw),
      format:      raw.format || "T20",
      leagueId:    String(raw.league?.id   || ""),
      leagueName:  raw.league?.name         || "",
      leagueLogo:  raw.league?.logo || raw.league?.image || raw.league?.imageUrl || raw.league?.imagePath || "",
      season:      raw.league?.season       || null,
      country:     raw.country?.code        || "",
      countryLogo: raw.country?.logo || raw.country?.image || "",
      batsmen:     [],
      bowlers:     [],
      matchKey:    `${home.shortName}_${away.shortName}_${String(raw.startDate || "").substring(0, 10)}`,
      sport:       "cricket",
      _provider:   "highlightly",
    };
  } catch (e) {
    console.warn("[HL Normalizer] normalizeFixture error:", e.message);
    return null;
  }
}

// ── normalizeLiveDetail ───────────────────────────────────────
// Enriches a normalized fixture with live batting/bowling from /cricket/matches/:id

function normalizeLiveDetail(detail, fixture) {
  if (!detail?.statistics?.length) return fixture;
  try {
    // Batting team = the inning that has "not out" batsmen currently
    const battingInning = detail.statistics.find(s =>
      s.team?.inningBatsmen?.some(b => b.dismissalStatus === "not out")
    );
    if (!battingInning) return fixture;

    const batsmen = (battingInning.team.inningBatsmen || [])
      .filter(b => b.dismissalStatus === "not out" && b.runs !== null)
      .slice(0, 2)
      .map(b => ({
        name:   b.player?.name || "",
        runs:   b.runs   ?? 0,
        balls:  b.balls  ?? 0,
        fours:  b.fours  ?? 0,
        sixes:  b.sixes  ?? 0,
        sr:     b.battingStrikeRate ?? 0,
      }));

    const bowlingInning = detail.statistics.find(s => s !== battingInning);
    const bowlers = (bowlingInning?.team?.inningBowlers || [])
      .filter(b => b.overs > 0)
      .slice(0, 2)
      .map(b => ({
        name:    b.player?.name || "",
        overs:   b.overs   ?? 0,
        runs:    b.runs    ?? 0,
        wickets: b.wickets ?? 0,
        economy: b.economy ?? 0,
      }));

    return {
      ...fixture,
      batsmen,
      bowlers,
      battingTeamId: String(battingInning.team?.id ?? ''),
    };
  } catch {
    return fixture;
  }
}

// ── normalizeScorecard ────────────────────────────────────────
// Converts /cricket/matches/:id response into structured scorecard.

function _dismissalText(b) {
  const status    = b.dismissalStatus || "";
  const fielders  = (b.dismissalFielders || []).map(f => f.name).filter(Boolean);
  if (status === "not out")  return "not out";
  if (!status)               return "";
  if (status === "caught" && fielders.length)    return `c ${fielders[0]}`;
  if (status === "stumped" && fielders.length)   return `st ${fielders[0]}`;
  if (status === "run out" && fielders.length)   return `run out (${fielders[0]})`;
  if (status === "hit wicket")                   return "hit wicket";
  if (status === "lbw")                          return "lbw";
  if (status === "bowled")                       return "b";
  return status;
}

function normalizeScorecard(detail, matchId) {
  if (!detail?.statistics?.length) return null;
  try {
    const innings = detail.statistics.map((s, idx) => {
      const t = s.team || {};
      const batsmen = (t.inningBatsmen || [])
        .filter(b => b.runs !== null || b.dismissalStatus === "not out")
        .map(b => ({
          name:          b.player?.name || "",
          playerId:      String(b.player?.id || ""),
          roles:         b.player?.roles || [],
          battingStyle:  b.player?.battingStyles?.[0] || "",
          runs:          b.runs   ?? 0,
          balls:         b.balls  ?? 0,
          fours:         b.fours  ?? 0,
          sixes:         b.sixes  ?? 0,
          strikeRate:    b.battingStrikeRate ?? 0,
          dismissal:     b.dismissalStatus || "not out",
          dismissalText: _dismissalText(b),
        }));

      const bowlers = (t.inningBowlers || []).map(b => ({
        name:         b.player?.name || "",
        playerId:     String(b.player?.id || ""),
        bowlingStyle: b.player?.bowlingStyles?.[0] || "",
        overs:        b.overs   ?? 0,
        maidens:      b.maidens ?? 0,
        runs:         b.concededRuns ?? b.runs ?? 0,
        wickets:      b.wickets ?? 0,
        economy:      b.economy ?? 0,
        noBalls:      b.noBalls ?? 0,
        wides:        b.wides   ?? 0,
      }));

      const fow = (t.fallOfWickets || []).map(f => ({
        runs:    f.runs,
        over:    f.overs,
        batsman: f.dismissalBatsman?.name || "",
        order:   f.order,
      }));

      // Derive total from last batsman score or fow
      const lastBatter = batsmen.filter(b => b.runs !== null).slice(-1)[0];
      const total = null; // not directly provided; derive from score field if needed

      return {
        inningIndex:  idx + 1,
        team:         { id: String(t.id || ""), name: t.name || "", shortName: t.abbreviation || t.shortName || "", logo: t.logo || t.image || t.imageUrl || "" },
        total,
        extras:       { total: t.extras ?? 0, wides: t.wides ?? 0, noBalls: t.noBalls ?? 0, byes: t.byes ?? 0, legByes: t.legByes ?? 0 },
        fours:        t.fours  ?? 0,
        sixes:        t.sixes  ?? 0,
        fallOfWickets: fow,
        batsmen,
        bowlers,
      };
    });

    return {
      matchId,
      innings,
      venue:    detail.venue?.name     || "",
      city:     detail.venue?.city     || "",
      forecast: detail.forecast        || null,
      _provider: "highlightly",
    };
  } catch (e) {
    console.warn("[HL Normalizer] normalizeScorecard error:", e.message);
    return null;
  }
}

// ── normalizeStandings ────────────────────────────────────────

function normalizeStandings(raw) {
  if (!raw?.groups?.length) return [];
  try {
    const group = raw.groups[0];
    return (group.standings || []).map(s => ({
      position: s.position   ?? 0,
      team: {
        id:        String(s.team?.id  || ""),
        name:      s.team?.name       || "",
        shortName: s.team?.abbreviation || "",
        logo:      s.team?.logo       || "",
      },
      played:  s.matchesPlayed ?? 0,
      won:     s.wins          ?? 0,
      lost:    s.loses         ?? 0,
      tied:    s.ties          ?? 0,
      points:  s.points        ?? 0,
      nrr:     s.netRunRate    ?? 0,
      for:     s.pointsFor     || "",
      against: s.pointsAgainst || "",
    }));
  } catch (e) {
    console.warn("[HL Normalizer] normalizeStandings error:", e.message);
    return [];
  }
}

// ── normalizeFootballFixture ──────────────────────────────────
// Converts a Highlightly football match into the app's standard match shape.
// Football status strings differ from cricket: FT, HT, 1H, 2H, AET, PEN, etc.

const FOOTBALL_LIVE_DESC = new Set([
  "In Play", "HT", "1H", "2H", "ET", "PEN", "Extra Time", "Penalties",
  "Half Time", "Live",
]);
const FOOTBALL_FINISHED_DESC = new Set([
  "FT", "Finished", "AET", "After Extra Time", "After Penalties",
  "AP", "Full Time", "Completed",
]);
const FOOTBALL_NO_RESULT_DESC = new Set([
  "Cancelled", "Postponed", "Abandoned", "Suspended", "Interrupted",
]);

function _footballStatus(desc) {
  if (!desc) return "upcoming";
  if (FOOTBALL_LIVE_DESC.has(desc))     return "live";
  if (FOOTBALL_FINISHED_DESC.has(desc)) return "completed";
  if (FOOTBALL_NO_RESULT_DESC.has(desc)) return "completed";
  return "upcoming";
}

// One-time debug helper — logs the raw keys on the first football fixture seen
// so we can identify the correct date field name from the Highlightly football API.
let _footballFieldsLogged = false;
function _logFootballFields(raw) {
  if (_footballFieldsLogged) return;
  _footballFieldsLogged = true;
  const top   = Object.keys(raw);
  const state = raw.state ? Object.keys(raw.state) : [];
  console.log(`[HL Normalizer] football fixture top-level keys: ${JSON.stringify(top)}`);
  console.log(`[HL Normalizer] football fixture state keys: ${JSON.stringify(state)}`);
  // Log date-candidate values
  const candidates = ["startTime","startDate","starting_at","startingAt","date","datetime",
    "dateTime","kickoff","kickoffAt","kickoff_at","utcDate","matchDate","scheduledAt",
    "start","startsAt","matchTime","matchStart"];
  const found = {};
  for (const k of candidates) if (raw[k] !== undefined) found[k] = raw[k];
  console.log(`[HL Normalizer] football date candidates found: ${JSON.stringify(found)}`);
}

function normalizeFootballFixture(raw) {
  if (!raw?.id) return null;
  try {
    _logFootballFields(raw);

    const home = _team(raw.homeTeam);
    const away = _team(raw.awayTeam);

    const desc   = raw.state?.description || raw.status || raw.state?.status || "";
    const status = _footballStatus(desc);

    // Goals — try multiple field patterns Highlightly uses
    const homeGoals = raw.state?.score?.home    ?? raw.state?.teams?.home?.score ??
                      raw.homeScore             ?? raw.score?.home              ?? null;
    const awayGoals = raw.state?.score?.away    ?? raw.state?.teams?.away?.score ??
                      raw.awayScore             ?? raw.score?.away              ?? null;

    const scoreStr = (homeGoals !== null && awayGoals !== null)
      ? `${homeGoals}-${awayGoals}` : null;

    let winner = null;
    if (status === "completed" && homeGoals !== null && awayGoals !== null) {
      if (Number(homeGoals) > Number(awayGoals))      winner = home.name;
      else if (Number(awayGoals) > Number(homeGoals)) winner = away.name;
      else                                             winner = "Draw";
    }

    // Try every field name the Highlightly football API might use for the kickoff time.
    // We'll narrow this to one field once _logFootballFields reveals which one is populated.
    const rawDate =
      raw.startTime    || raw.startDate    ||
      raw.starting_at  || raw.startingAt   ||
      raw.date         || raw.datetime     || raw.dateTime     ||
      raw.kickoff      || raw.kickoffAt    || raw.kickoff_at   ||
      raw.utcDate      || raw.matchDate    || raw.scheduledAt  ||
      raw.startsAt     || raw.matchTime    || raw.matchStart   ||
      raw.state?.kickoff || raw.state?.date || raw.state?.startTime || null;

    let statusText = "";
    if (status === "completed") {
      statusText = winner === "Draw"
        ? `Draw ${scoreStr || ""}`
        : winner ? `${winner} won ${scoreStr || ""}` : scoreStr || "";
    } else if (status === "upcoming") {
      statusText = `Match starts at ${_formatMatchTime(rawDate)}`;
    } else {
      statusText = desc;
    }

    return {
      id:          String(raw.id),
      date:        rawDate,
      team1:       home,
      team2:       away,
      score1:      scoreStr,
      score2:      null,
      overs1:      null,
      overs2:      null,
      status,
      statusText,
      venue:       raw.venue?.name || (typeof raw.venue === "string" ? raw.venue : "") || "",
      toss:        null,
      winner,
      seriesLabel: `${raw.league?.name || ""} ${raw.league?.season || ""}`.trim(),
      matchStage:  raw.round?.name || (typeof raw.round === "string" ? raw.round : "") || "MATCH",
      format:      "90min",
      leagueId:    String(raw.league?.id || ""),
      leagueName:  raw.league?.name  || "",
      leagueLogo:  raw.league?.logo || raw.league?.image || raw.league?.imageUrl || "",
      season:      raw.league?.season || null,
      country:     raw.country?.code || raw.league?.country?.code || "",
      countryLogo: raw.country?.logo || raw.country?.image || raw.league?.country?.logo || "",
      batsmen:     [],
      bowlers:     [],
      matchKey:    `${home.shortName}_${away.shortName}_${String(rawDate || "").substring(0, 10)}`,
      sport:       "football",
      _provider:   "highlightly",
    };
  } catch (e) {
    console.warn("[HL Normalizer] normalizeFootballFixture error:", e.message);
    return null;
  }
}

// ── normalizeHighlight ────────────────────────────────────────

function normalizeHighlight(raw, sport = "cricket") {
  if (!raw?.id) return null;
  return {
    id:       String(raw.id),
    sport,
    type:     raw.type     || "",
    title:    raw.title    || "",
    url:      raw.url      || "",
    embedUrl: raw.embedUrl || "",
    imgUrl:   raw.imgUrl   || "",
    channel:  raw.channel  || "",
    source:   raw.source   || "",
    category: raw.category || "",
    matchId:  String(raw.match?.id || ""),
    match:    raw.match    || null,
  };
}

// ── normalizeFootballEvents ───────────────────────────────────
// Extracts goals, cards, substitutions from match detail.

function normalizeFootballEvents(events = []) {
  if (!Array.isArray(events)) return [];
  return events.map(e => ({
    time:      e.time || e.minute || "",
    type:      e.type || "",
    team:      e.team ? { id: String(e.team.id || ""), name: e.team.name || "", logo: e.team.logo || "" } : null,
    player:    e.player || e.playerName || "",
    playerId:  e.playerId ? String(e.playerId) : null,
    assist:    e.assist || e.assistingPlayer || null,
    assistId:  e.assistingPlayerId ? String(e.assistingPlayerId) : null,
    substituted: e.substituted || null,
  })).filter(e => e.type);
}

// ── normalizeFootballStats ────────────────────────────────────
// Extracts per-team match statistics (possession, shots, etc.)

function normalizeFootballStats(statistics = []) {
  if (!Array.isArray(statistics)) return null;
  const result = {};
  for (const teamStat of statistics) {
    if (!teamStat?.team?.id) continue;
    const key = String(teamStat.team.id);
    const stats = {};
    for (const s of (teamStat.statistics || [])) {
      if (s.displayName) stats[s.displayName] = s.value;
    }
    result[key] = {
      team: { id: key, name: teamStat.team.name || "", logo: teamStat.team.logo || "" },
      stats,
    };
  }
  return Object.keys(result).length ? result : null;
}

// ── normalizeFootballPredictions ─────────────────────────────
// Extracts API-provided win probability from match detail.

function normalizeFootballPredictions(predictions) {
  if (!predictions) return null;
  const prematch = predictions.prematch?.[0] || predictions[0];
  if (!prematch?.probabilities) return null;
  const p = prematch.probabilities;
  return {
    home:        parseFloat(String(p.home || "0").replace("%", "")) || 0,
    draw:        parseFloat(String(p.draw || "0").replace("%", "")) || 0,
    away:        parseFloat(String(p.away || "0").replace("%", "")) || 0,
    type:        prematch.type || "WinDrawWin",
    generatedAt: prematch.generatedAt || new Date().toISOString(),
    source:      "api",
  };
}

// ── normalizeFootballLineups ──────────────────────────────────
// Extracts formation and player lists from the lineups endpoint.

function normalizeFootballLineups(raw) {
  if (!raw) return null;

  function _processTeam(side) {
    if (!side) return null;
    return {
      id:        String(side.id || ""),
      name:      side.name || "",
      logo:      side.logo || side.image || "",
      formation: side.formation || "",
      lineup:    (side.initialLineup || []).flat().map(p => ({
        id:       String(p.id || ""),
        name:     p.name || "",
        number:   p.number ?? null,
        position: p.position || "",
      })),
      substitutes: (side.substitutes || []).map(p => ({
        id:       String(p.id || ""),
        name:     p.name || "",
        number:   p.number ?? null,
        position: p.position || "",
      })),
    };
  }

  return {
    homeTeam: _processTeam(raw.homeTeam),
    awayTeam: _processTeam(raw.awayTeam),
  };
}

module.exports = {
  normalizeFixture,
  normalizeFootballFixture,
  normalizeLiveDetail,
  normalizeScorecard,
  normalizeStandings,
  normalizeHighlight,
  normalizeFootballEvents,
  normalizeFootballStats,
  normalizeFootballPredictions,
  normalizeFootballLineups,
};
