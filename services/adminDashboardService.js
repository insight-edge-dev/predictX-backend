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
const cacheService = require("./cacheService");
const jobTracker = require("./jobTracker");
const sm = require("./sportmonksService");


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
      const { live: liveMatches, upcoming, completed } = await leagueService.getLeagueMatches(league);
      leagues.push({
        slug: league.slug, name: league.name, flag: league.flag, sport: "football",
        live: liveMatches.length, upcoming: upcoming.length, completed: completed.length,
      });
      for (const m of liveMatches) {
        live.push({
          id: String(m.id), league: league.slug, leagueName: league.name, flag: league.flag,
          team1: m.team1?.shortName || m.team1?.name || "TBA",
          team2: m.team2?.shortName || m.team2?.name || "TBA",
          score1: m.score1 ?? null, score2: m.score2 ?? null,
          matchDesc: m.statusText || "", venue: m.venue || "",
          status: m.status, hasScoreData: !!(m.score1 || m.score2),
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
        const st = internationalService.effectiveStatus(m);
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

// ── System health: per-league freshness + scheduled jobs + cache + quota ──

async function getSystemHealth() {
  const { leagues } = await getMatchMonitor();

  return {
    leagues,
    jobs: jobTracker.getAll(),
    cache: cacheService.listEntries(),
    sportmonks: sm.getRateLimitStatus(),
  };
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

// ── Analytics ──────────────────────────────────────────────────

function dateRange(days) {
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

async function getAnalytics({ days = 30 } = {}) {
  const since    = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const dayAgo   = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    totalUsers, dau, wau, mau, newToday,
    userGrowthRows, activeUserRows, predRows, platformRows, predOutcomeRows, engagementRows,
    commentRows, notifRows,
  ] = await Promise.all([
    supabase.from("app_users").select("*", { count: "exact", head: true }),
    supabase.from("app_users").select("*", { count: "exact", head: true }).gte("last_active_at", dayAgo),
    supabase.from("app_users").select("*", { count: "exact", head: true }).gte("last_active_at", weekAgo),
    supabase.from("app_users").select("*", { count: "exact", head: true }).gte("last_active_at", monthAgo),
    supabase.from("app_users").select("*", { count: "exact", head: true }).gte("created_at", dayAgo),
    supabase.from("app_users").select("created_at").gte("created_at", since).order("created_at", { ascending: true }),
    supabase.from("app_users").select("last_active_at").gte("last_active_at", since),
    supabase.from("user_match_predictions").select("created_at, sport").gte("created_at", since),
    supabase.from("push_tokens").select("platform"),
    supabase.from("user_match_predictions").select("result").not("result", "is", null),
    supabase.from("app_users").select("predictions_count"),
    supabase.from("match_comments").select("created_at").gte("created_at", since),
    supabase.from("notifications").select("scheduled_at").gte("scheduled_at", since),
  ]);

  const days_ = dateRange(days);

  // User growth by day
  const growthMap = {};
  for (const r of (userGrowthRows.data ?? [])) {
    const d = r.created_at.slice(0, 10);
    growthMap[d] = (growthMap[d] ?? 0) + 1;
  }

  // Active users by day (approximate from last_active_at)
  const activeMap = {};
  for (const r of (activeUserRows.data ?? [])) {
    const d = r.last_active_at.slice(0, 10);
    activeMap[d] = (activeMap[d] ?? 0) + 1;
  }

  // Predictions by day + sport
  const predMap = {};
  for (const r of (predRows.data ?? [])) {
    const d = r.created_at.slice(0, 10);
    if (!predMap[d]) predMap[d] = { cricket: 0, football: 0 };
    const sport = r.sport === "football" ? "football" : "cricket";
    predMap[d][sport]++;
  }

  // Comments by day
  const commentMap = {};
  for (const r of (commentRows.data ?? [])) {
    const d = r.created_at.slice(0, 10);
    commentMap[d] = (commentMap[d] ?? 0) + 1;
  }

  // Platform split
  const platformMap = {};
  for (const r of (platformRows.data ?? [])) {
    const p = r.platform ?? "unknown";
    platformMap[p] = (platformMap[p] ?? 0) + 1;
  }

  // Prediction outcomes
  const outcomes = { correct: 0, wrong: 0, void: 0 };
  for (const r of (predOutcomeRows.data ?? [])) {
    if (r.result === "correct") outcomes.correct++;
    else if (r.result === "wrong") outcomes.wrong++;
    else outcomes.void++;
  }

  // Engagement tiers
  const tiers = { "0": 0, "1-5": 0, "6-20": 0, "21-50": 0, "50+": 0 };
  for (const r of (engagementRows.data ?? [])) {
    const c = r.predictions_count ?? 0;
    if (c === 0)        tiers["0"]++;
    else if (c <= 5)    tiers["1-5"]++;
    else if (c <= 20)   tiers["6-20"]++;
    else if (c <= 50)   tiers["21-50"]++;
    else                tiers["50+"]++;
  }

  return {
    kpis: {
      totalUsers:  totalUsers.count  ?? 0,
      dau:         dau.count         ?? 0,
      wau:         wau.count         ?? 0,
      mau:         mau.count         ?? 0,
      newToday:    newToday.count    ?? 0,
      pushEnabled: (platformRows.data ?? []).length,
    },
    userGrowth:  days_.map(d => ({ day: d, count: growthMap[d]  ?? 0 })),
    activeUsers: days_.map(d => ({ day: d, count: activeMap[d]  ?? 0 })),
    predictions: days_.map(d => ({
      day: d,
      cricket:  predMap[d]?.cricket  ?? 0,
      football: predMap[d]?.football ?? 0,
    })),
    comments:    days_.map(d => ({ day: d, count: commentMap[d] ?? 0 })),
    platforms:   Object.entries(platformMap).map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value })),
    outcomes:    [
      { name: "Correct", value: outcomes.correct, color: "#16a34a" },
      { name: "Wrong",   value: outcomes.wrong,   color: "#ef4444" },
      { name: "Void",    value: outcomes.void,     color: "#7E97B0" },
    ],
    engagementTiers: Object.entries(tiers).map(([tier, count]) => ({ tier: tier === "0" ? "No picks" : tier + " picks", count })),
  };
}

module.exports = {
  getMatchMonitor,
  getSystemHealth,
  getOverviewStats,
  listUsers,
  getAnalytics,
};
