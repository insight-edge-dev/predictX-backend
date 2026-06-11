/**
 * footballNormalizer.js — maps football-data.org v4 responses → app FootballMatch format.
 *
 * Source schema (per match):
 * {
 *   id: 12345,
 *   utcDate: "2026-06-11T19:00:00Z",
 *   status: "TIMED" | "SCHEDULED" | "IN_PLAY" | "PAUSED" | "FINISHED" | "POSTPONED" | "SUSPENDED" | "CANCELLED",
 *   stage:  "GROUP_STAGE" | "LAST_32" | "LAST_16" | "QUARTER_FINALS" | "SEMI_FINALS" | "THIRD_PLACE" | "FINAL",
 *   group:  "GROUP_A" | null,        // null for knockout fixtures
 *   homeTeam: { id, name, shortName, tla, crest } | null,   // null = bracket slot not yet determined
 *   awayTeam: { ... } | null,
 *   score: {
 *     winner: "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null,
 *     fullTime: { home, away },
 *     halfTime: { home, away }
 *   },
 *   venue: "Estadio Azteca",
 * }
 *
 * Source schema (per standing row, within a TOTAL/HOME/AWAY table view):
 * {
 *   position, team: { id, name, shortName, tla, crest },
 *   playedGames, won, draw, lost, points,
 *   goalsFor, goalsAgainst, goalDifference, form
 * }
 *
 * The API returns one flat 48-team table per view (no per-group split) —
 * we bucket rows into WC groups (A–L) using the team's FIFA code (`tla`)
 * looked up in our WC2026_TEAMS registry.
 */

const { getTeam } = require("../constants/wc2026Teams");

// ── IST formatter ─────────────────────────────────────────────────

function toIST(utcString) {
  if (!utcString) return { date: "", time: "" };
  const d = new Date(utcString);
  // IST = UTC + 5:30
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const date = ist.toISOString().split("T")[0];
  const h = String(ist.getUTCHours()).padStart(2, "0");
  const m = String(ist.getUTCMinutes()).padStart(2, "0");
  return { date, time: `${h}:${m} IST` };
}

// ── Status mapping ─────────────────────────────────────────────────

function mapStatus(raw) {
  switch (raw.status) {
    case "IN_PLAY":   return { status: "live",      statusText: "LIVE" };
    case "PAUSED":    return { status: "live",      statusText: "HT" };
    case "FINISHED":  return { status: "completed", statusText: "FT" };
    case "POSTPONED": return { status: "upcoming",  statusText: "Postponed" };
    case "SUSPENDED": return { status: "live",      statusText: "Suspended" };
    case "CANCELLED": return { status: "completed", statusText: "Cancelled" };
    default:          return { status: "upcoming",  statusText: "" }; // TIMED / SCHEDULED
  }
}

// ── Stage / group mapping ──────────────────────────────────────────

const STAGE_MAP = {
  GROUP_STAGE:    "Group Stage",
  LAST_32:        "Round of 32",
  LAST_16:        "Round of 16",
  QUARTER_FINALS: "Quarter-Final",
  SEMI_FINALS:    "Semi-Final",
  THIRD_PLACE:    "3rd Place",
  FINAL:          "Final",
};

function parseStage(raw) {
  return STAGE_MAP[raw.stage] ?? "Group Stage";
}

function parseGroup(raw) {
  if (!raw.group) return null;
  const m = String(raw.group).match(/GROUP_([A-L])/i);
  return m ? m[1].toUpperCase() : null;
}

// ── Team enrichment from our WC registry ─────────────────────────
// football-data.org's `tla` (3-letter FIFA code) matches our registry keys directly.

const TBD_TEAM = { id: "", name: "TBD", shortName: "TBD", logo: "", flag: "🏳", color: "#6B7280" };

function enrichTeam(raw) {
  // Undetermined knockout bracket slots come back as either `null` or an
  // object with every field set to `null` (e.g. { id: null, name: null, ... }).
  if (!raw || raw.id == null) return { ...TBD_TEAM };

  const wc = getTeam(raw.tla) ?? getTeam(raw.name) ?? getTeam(raw.shortName ?? "");
  return {
    id:        String(raw.id ?? ""),
    name:      wc?.name      ?? raw.name        ?? raw.shortName ?? "Unknown",
    shortName: wc?.shortName ?? raw.tla         ?? raw.shortName?.slice(0, 3).toUpperCase() ?? "UNK",
    logo:      raw.crest     ?? "",
    flag:      wc?.flag      ?? "🏳",
    color:     wc?.color     ?? "#6B7280",
  };
}

// ── Fixture normalizer ────────────────────────────────────────────

function normalizeFixture(raw) {
  const { date, time }       = toIST(raw.utcDate);
  const { status, statusText } = mapStatus(raw);
  const stage = parseStage(raw);
  const group = parseGroup(raw);

  const isPlayed = status === "live" || status === "completed";
  const ft = raw.score?.fullTime ?? {};
  const ht = raw.score?.halfTime ?? {};

  return {
    id:         String(raw.id ?? ""),
    homeTeam:   enrichTeam(raw.homeTeam),
    awayTeam:   enrichTeam(raw.awayTeam),
    score: {
      home:   isPlayed ? (ft.home ?? null) : null,
      away:   isPlayed ? (ft.away ?? null) : null,
      htHome: isPlayed ? (ht.home ?? null) : null,
      htAway: isPlayed ? (ht.away ?? null) : null,
    },
    status,
    statusText,
    minute:     null,   // not exposed on list/competition endpoints
    venue:      raw.venue ?? "",
    city:       "",
    date,
    time,
    stage,
    group,
    sport:      "football",
  };
}

// ── Standings normalizer ──────────────────────────────────────────

function normalizeStanding(raw, rank) {
  const wc = getTeam(raw.team?.tla) ?? getTeam(raw.team?.name ?? "");

  return {
    rank: rank + 1,
    team: {
      id:        String(raw.team?.id ?? ""),
      name:      wc?.name      ?? raw.team?.name  ?? "Unknown",
      shortName: wc?.shortName ?? raw.team?.tla   ?? "UNK",
      logo:      raw.team?.crest ?? "",
      flag:      wc?.flag      ?? "🏳",
      color:     wc?.color     ?? "#6B7280",
    },
    played:       raw.playedGames    ?? 0,
    won:          raw.won            ?? 0,
    drawn:        raw.draw           ?? 0,
    lost:         raw.lost           ?? 0,
    goalsFor:     raw.goalsFor       ?? 0,
    goalsAgainst: raw.goalsAgainst   ?? 0,
    goalDiff:     raw.goalDifference ?? (raw.goalsFor ?? 0) - (raw.goalsAgainst ?? 0),
    points:       raw.points         ?? 0,
    form:         raw.form ?? "",
    qualified:    rank < 2,   // top 2 in group advance
  };
}

/**
 * The API returns one flat 48-team table per view (TOTAL/HOME/AWAY) — no
 * per-group split. We bucket each row into its WC group (A–L) using the
 * team's FIFA code looked up in our registry, then re-rank within group
 * (the API's `position` is the global rank, not the in-group rank).
 *
 * Returns Record<string, NormalizedStanding[]>  e.g. { "Group A": [...], ... }
 */
function normalizeGroups(rawStandings) {
  if (!Array.isArray(rawStandings) || rawStandings.length === 0) return {};

  const totalView = rawStandings.find(s => s.type === "TOTAL") ?? rawStandings[0];
  const rows = totalView?.table ?? [];
  if (rows.length === 0) return {};

  const buckets = {};
  for (const row of rows) {
    const wc = getTeam(row.team?.tla) ?? getTeam(row.team?.name ?? "");
    const groupName = wc?.group ? `Group ${wc.group}` : "Other";
    if (!buckets[groupName]) buckets[groupName] = [];
    buckets[groupName].push(row);
  }

  const result = {};
  for (const [name, groupRows] of Object.entries(buckets)) {
    result[name] = groupRows
      .sort((a, b) =>
        (b.points ?? 0) - (a.points ?? 0) ||
        (b.goalDifference ?? 0) - (a.goalDifference ?? 0) ||
        (b.goalsFor ?? 0) - (a.goalsFor ?? 0))
      .map((row, i) => normalizeStanding(row, i));
  }

  return result;
}

module.exports = { normalizeFixture, normalizeStanding, normalizeGroups };
