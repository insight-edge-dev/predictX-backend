/**
 * adminDashboardService.js — aggregation for the admin dashboard.
 *
 * Reuses the same per-league/per-bucket fetchers the public app uses
 * (leagueService, footballService, internationalService) — all already
 * cached, so calling them repeatedly here is cheap.
 */

const supabase = require("../config/supabase");
const { LEAGUES, FOOTBALL_LEAGUES } = require("../config/leaguesConfig");
const leagueService = require("./leagueService");
const footballService = require("./footballService");
const internationalService = require("./internationalService");

const STARTED_BUFFER_MS = 4 * 60 * 60 * 1000; // mirrors internationalService

function effectiveIntlStatus(m) {
  if (m.status === "live") return "live";
  const startedInPast = m.date && (Date.now() - new Date(m.date).getTime()) > STARTED_BUFFER_MS;
  if (m.status === "completed" || startedInPast) return "completed";
  return "upcoming";
}

// ── Match monitor: per-league counts + live-match data-quality flags ──

async function getMatchMonitor() {
  const leagues = [];
  const live = [];

  for (const league of Object.values(LEAGUES)) {
    try {
      const { live: liveMatches, upcoming, completed } = await leagueService.getLeagueMatches(league);
      leagues.push({
        slug: league.slug, name: league.name, flag: league.flag, sport: "cricket",
        live: liveMatches.length, upcoming: upcoming.length, completed: completed.length,
      });
      for (const m of liveMatches) {
        live.push({
          id: String(m.id), league: league.slug, leagueName: league.name, flag: league.flag,
          team1: m.team1?.shortName || m.team1?.name || "TBA",
          team2: m.team2?.shortName || m.team2?.name || "TBA",
          score1: m.score1 ?? null, score2: m.score2 ?? null,
          matchDesc: m.matchDesc || "", venue: m.venue || "",
          status: m.status, hasScoreData: !!(m.score1 || m.score2),
        });
      }
    } catch (e) {
      console.warn(`[AdminDashboard] league ${league.slug} failed:`, e.message);
      leagues.push({ slug: league.slug, name: league.name, flag: league.flag, sport: "cricket", live: 0, upcoming: 0, completed: 0, error: true });
    }
  }

  for (const league of Object.values(FOOTBALL_LEAGUES)) {
    try {
      const { live: liveMatches, upcoming, completed } = await footballService.getMatches();
      leagues.push({
        slug: league.slug, name: league.name, flag: league.flag, sport: "football",
        live: liveMatches.length, upcoming: upcoming.length, completed: completed.length,
      });
      for (const m of liveMatches) {
        live.push({
          id: String(m.id), league: league.slug, leagueName: league.name, flag: league.flag,
          team1: m.homeTeam?.shortName || m.homeTeam?.name || "TBA",
          team2: m.awayTeam?.shortName || m.awayTeam?.name || "TBA",
          score1: m.score?.home ?? null, score2: m.score?.away ?? null,
          matchDesc: m.statusText || "", venue: m.venue || "",
          status: m.status, hasScoreData: m.score?.home != null || m.score?.away != null,
        });
      }
    } catch (e) {
      console.warn(`[AdminDashboard] football ${league.slug} failed:`, e.message);
      leagues.push({ slug: league.slug, name: league.name, flag: league.flag, sport: "football", live: 0, upcoming: 0, completed: 0, error: true });
    }
  }

  for (const bucket of Object.values(internationalService.INTERNATIONAL_LEAGUES)) {
    try {
      const fixtures = await internationalService.getBucketFixtures(bucket);
      let liveCount = 0, upcomingCount = 0, completedCount = 0;
      for (const m of fixtures) {
        const st = effectiveIntlStatus(m);
        if (st === "live") {
          liveCount++;
          live.push({
            id: String(m.id), league: bucket.slug, leagueName: m.stageName || bucket.name, flag: bucket.flag,
            team1: m.team1?.shortName || m.team1?.name || "TBA",
            team2: m.team2?.shortName || m.team2?.name || "TBA",
            score1: m.score1 ?? null, score2: m.score2 ?? null,
            matchDesc: m.matchDesc || "", venue: m.venue || "",
            status: "live", hasScoreData: !!(m.score1 || m.score2),
          });
        } else if (st === "completed") completedCount++;
        else upcomingCount++;
      }
      leagues.push({ slug: bucket.slug, name: bucket.name, flag: bucket.flag, sport: "international", live: liveCount, upcoming: upcomingCount, completed: completedCount });
    } catch (e) {
      console.warn(`[AdminDashboard] international ${bucket.slug} failed:`, e.message);
      leagues.push({ slug: bucket.slug, name: bucket.name, flag: bucket.flag, sport: "international", live: 0, upcoming: 0, completed: 0, error: true });
    }
  }

  return { leagues, live };
}

// ── Overview stats ─────────────────────────────────────────────

async function getOverviewStats() {
  const monitor = await getMatchMonitor();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const [
    usersTotal, usersNew,
    predTotal, predPublished,
    notifTotal, notifScheduled,
  ] = await Promise.all([
    supabase.from("app_users").select("*", { count: "exact", head: true }),
    supabase.from("app_users").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
    supabase.from("expert_predictions").select("*", { count: "exact", head: true }),
    supabase.from("expert_predictions").select("*", { count: "exact", head: true }).eq("is_published", true),
    supabase.from("notifications").select("*", { count: "exact", head: true }),
    supabase.from("notifications").select("*", { count: "exact", head: true }).gt("scheduled_at", now),
  ]);

  const predTotalCount = predTotal.count ?? 0;
  const predPublishedCount = predPublished.count ?? 0;
  const notifTotalCount = notifTotal.count ?? 0;
  const notifScheduledCount = notifScheduled.count ?? 0;

  return {
    users: { total: usersTotal.count ?? 0, newThisWeek: usersNew.count ?? 0 },
    predictions: { total: predTotalCount, published: predPublishedCount, draft: predTotalCount - predPublishedCount },
    notifications: { total: notifTotalCount, sent: notifTotalCount - notifScheduledCount, scheduled: notifScheduledCount },
    liveMatchCount: monitor.live.length,
    liveMatches: monitor.live.slice(0, 5),
  };
}

// ── Users list ──────────────────────────────────────────────────

async function listUsers({ search = "", page = 1, limit = 20 }) {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from("app_users")
    .select("id, phone, display_name, created_at, predictions_count, matches_tracked, favourite_teams", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  const term = search.trim();
  if (term) {
    const escaped = term.replace(/[%,]/g, "");
    query = query.or(`display_name.ilike.%${escaped}%,phone.ilike.%${escaped}%`);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return { users: data ?? [], total: count ?? 0, page, limit };
}

module.exports = {
  getMatchMonitor,
  getOverviewStats,
  listUsers,
};
