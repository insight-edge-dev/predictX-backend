const express    = require("express");
const adminAuth  = require("../middleware/adminAuth");
const upload     = require("../middleware/upload");
const ctrl       = require("../controllers/adminController");
const resolver   = require("../services/resolverService");

const router = express.Router();

// Public login endpoint — validates credentials server-side and returns the
// admin key so the frontend never needs VITE_ADMIN_KEY in its bundle.
router.post("/admin/login", (req, res) => {
  const { user, pass } = req.body ?? {};
  if (
    user && pass &&
    user === process.env.ADMIN_USER &&
    pass === process.env.ADMIN_PASS
  ) {
    return res.json({ token: process.env.ADMIN_KEY });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

// Each route has adminAuth inline — avoids blocking non-admin routes
router.post  ("/admin/notifications",          adminAuth, ctrl.createNotification);
router.get   ("/admin/notifications",          adminAuth, ctrl.listNotificationsAdmin);
router.delete("/admin/notifications/:id",      adminAuth, ctrl.deleteNotification);

router.post  ("/admin/expert-predictions",     adminAuth, ctrl.createExpertPrediction);
router.get   ("/admin/expert-predictions",     adminAuth, ctrl.listExpertPredictionsAdmin);
router.put   ("/admin/expert-predictions/:id", adminAuth, ctrl.updateExpertPrediction);
router.delete("/admin/expert-predictions/:id", adminAuth, ctrl.deleteExpertPrediction);

router.get("/admin/matches", adminAuth, ctrl.getUpcomingMatchesPicker);

router.post("/admin/push-broadcast", adminAuth, ctrl.sendPushBroadcast);

router.get("/admin/overview", adminAuth, ctrl.getOverview);
router.get("/admin/monitor",  adminAuth, ctrl.getMatchMonitor);
router.get("/admin/health",   adminAuth, ctrl.getSystemHealth);
router.post("/admin/refresh/:slug", adminAuth, ctrl.refreshLeague);
router.get("/admin/users",        adminAuth, ctrl.listUsersAdmin);
router.get("/admin/users/:id",    adminAuth, ctrl.getUserDetail);
router.get("/admin/leaderboard",         adminAuth, ctrl.getLeaderboardAdmin);
router.get("/admin/prediction-analytics", adminAuth, ctrl.getPredictionAnalytics);

router.post  ("/admin/banners/upload",  adminAuth, upload.single("image"), ctrl.uploadBannerImage);
router.post  ("/admin/banners",         adminAuth, ctrl.createBanner);
router.get   ("/admin/banners",         adminAuth, ctrl.listBannersAdmin);
router.put   ("/admin/banners/reorder", adminAuth, ctrl.reorderBanners);
router.put   ("/admin/banners/:id",     adminAuth, ctrl.updateBanner);
router.delete("/admin/banners/:id",     adminAuth, ctrl.deleteBanner);

router.post  ("/admin/facts",         adminAuth, ctrl.createFact);
router.get   ("/admin/facts",         adminAuth, ctrl.listFactsAdmin);
router.put   ("/admin/facts/reorder", adminAuth, ctrl.reorderFacts);
router.put   ("/admin/facts/:id",     adminAuth, ctrl.updateFact);
router.delete("/admin/facts/:id",     adminAuth, ctrl.deleteFact);

router.get("/admin/league-priority",      adminAuth, ctrl.listLeaguePriority);
router.put("/admin/league-priority/:slug", adminAuth, ctrl.setLeaguePriority);

router.get("/admin/home-sections",         adminAuth, ctrl.listHomeSectionsAdmin);
router.put("/admin/home-sections/reorder", adminAuth, ctrl.reorderHomeSections);
router.put("/admin/home-sections/:key",    adminAuth, ctrl.setHomeSectionEnabled);

router.get("/admin/accuracy",      adminAuth, ctrl.listAccuracyAdmin);
router.put("/admin/accuracy/:key", adminAuth, ctrl.setAccuracyOverride);

router.get("/admin/league-cards",         adminAuth, ctrl.listLeagueCardSettingsAdmin);
router.put("/admin/league-cards/reorder", adminAuth, ctrl.reorderLeagueCards);
router.put("/admin/league-cards/:slug",   adminAuth, ctrl.setLeagueCardVisible);

router.get   ("/admin/analytics",          adminAuth, ctrl.getAnalytics);
router.get   ("/admin/external-analytics", adminAuth, ctrl.getExternalAnalytics);

router.get   ("/admin/comments",     adminAuth, ctrl.listCommentsAdmin);
router.delete("/admin/comments/:id", adminAuth, ctrl.deleteCommentAdmin);

// ── Prediction resolution ──────────────────────────────────────
// POST /api/admin/resolve-match          → manual single-match resolve
// POST /api/admin/resolve-scan           → trigger the auto-scan now

// ── App Config ────────────────────────────────────────────────
// GET  /api/admin/config   → read key-value config from app_config table
// POST /api/admin/config   → upsert all config keys

const supabase = require("../config/supabase");
const CONFIG_ROW_KEY = "app_config";

router.get("/admin/config", adminAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", CONFIG_ROW_KEY)
      .maybeSingle();
    if (error) throw error;
    return res.json({ config: data?.value ?? {} });
  } catch (e) {
    console.error("[Admin] config GET error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

router.post("/admin/config", adminAuth, async (req, res) => {
  const value = req.body ?? {};
  try {
    const { error } = await supabase
      .from("app_config")
      .upsert({ key: CONFIG_ROW_KEY, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return res.json({ success: true });
  } catch (e) {
    console.error("[Admin] config POST error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── Feature Flags ─────────────────────────────────────────────
const FEATURE_FLAGS_KEY = "feature_flags";

router.get("/admin/feature-flags", adminAuth, async (_req, res) => {
  try {
    const { data } = await supabase.from("app_config").select("value").eq("key", FEATURE_FLAGS_KEY).maybeSingle();
    return res.json({ flags: data?.value ?? {} });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/admin/feature-flags", adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("app_config")
      .upsert({ key: FEATURE_FLAGS_KEY, value: req.body ?? {}, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Maintenance Actions (used by HealthPage) ───────────────────
const { flushCache } = require("../services/cacheService");

router.post("/admin/cache/flush", adminAuth, (_req, res) => {
  try {
    flushCache();
    return res.json({ success: true, message: "In-memory cache flushed — fresh data will be fetched on next request" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/admin/reset-matches", adminAuth, async (_req, res) => {
  try {
    flushCache();
    return res.json({ success: true, message: "Match cache cleared — all leagues will re-sync on next request" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/admin/fix-empty-squads", adminAuth, async (_req, res) => {
  try {
    // Flush squad-related cache keys so they are re-fetched fresh
    flushCache();
    return res.json({ success: true, message: "Squad cache cleared — squads will be re-fetched on next match load" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post("/admin/resolve-match", adminAuth, async (req, res) => {
  const { matchId, winner } = req.body ?? {};
  if (!matchId || !winner) {
    return res.status(400).json({ error: "matchId and winner are required" });
  }
  try {
    const result = await resolver.resolveMatch(matchId, winner);
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error("[Admin] resolve-match error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

router.post("/admin/resolve-scan", adminAuth, async (req, res) => {
  try {
    const resolved = await resolver.runAutoResolve();
    return res.json({ success: true, resolved, message: resolved > 0 ? `Resolved ${resolved} prediction batch(es)` : "Scan complete — nothing new to resolve" });
  } catch (e) {
    console.error("[Admin] resolve-scan error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── League Directory ──────────────────────────────────────────
const { ALL_LEAGUES, LEAGUES, FOOTBALL_LEAGUES } = require('../config/leaguesConfig');

router.get('/admin/leagues', adminAuth, async (_req, res) => {
  try {
    const { data: ffData } = await supabase.from('app_config').select('value').eq('key', 'feature_flags').maybeSingle();
    const flags = ffData?.value ?? {};

    const leagues = Object.values(ALL_LEAGUES).map(l => ({
      slug:         l.slug,
      name:         l.name,
      short:        l.short,
      flag:         l.flag,
      country:      l.country,
      format:       l.format,
      sport:        l.sport,
      season:       l.season,
      leagueId:     l.leagueId ?? null,
      seasonId:     l.seasonId ?? null,
      homeBundle:   l.homeBundle !== false,
      sportEnabled: l.sport === 'cricket' ? (flags['cricket'] !== false) : (flags['football'] !== false),
    }));

    return res.json({
      leagues,
      counts: { total: leagues.length, cricket: Object.values(LEAGUES).length, football: Object.values(FOOTBALL_LEAGUES).length },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Prediction Algorithm Config ───────────────────────────────
const ALGO_CONFIG_KEY = 'prediction_algorithm';
const DEFAULT_ALGO = {
  h2hWeight: 40, careerWeight: 45, positionWeight: 15,
  minBallsFaced: 20, minInnings: 15,
  positionMultipliers: { opener: 1.15, topOrder: 1.10, middleOrder: 1.00, finisher: 1.05, allRounder: 1.10, bowler: 0.85, wicketKeeper: 0.95 },
  confidenceThresholds: { high: 65, medium: 52 },
};

router.get('/admin/algo-config', adminAuth, async (_req, res) => {
  try {
    const { data } = await supabase.from('app_config').select('value').eq('key', ALGO_CONFIG_KEY).maybeSingle();
    return res.json({ config: { ...DEFAULT_ALGO, ...(data?.value ?? {}) }, defaults: DEFAULT_ALGO });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/algo-config', adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('app_config')
      .upsert({ key: ALGO_CONFIG_KEY, value: req.body ?? {}, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Activity Feed ─────────────────────────────────────────────
router.get('/admin/activity', adminAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '60', 10), 100);
    const [predsRes, usersRes, commentsRes] = await Promise.allSettled([
      supabase.from('user_match_predictions').select('user_id, match_id, predicted_winner, sport, created_at').order('created_at', { ascending: false }).limit(25),
      supabase.from('app_users').select('id, display_name, created_at').order('created_at', { ascending: false }).limit(15),
      supabase.from('match_comments').select('user_id, match_id, content, created_at').order('created_at', { ascending: false }).limit(20),
    ]);

    const preds    = predsRes.status    === 'fulfilled' ? (predsRes.value.data    ?? []) : [];
    const users    = usersRes.status    === 'fulfilled' ? (usersRes.value.data    ?? []) : [];
    const comments = commentsRes.status === 'fulfilled' ? (commentsRes.value.data ?? []) : [];

    const activities = [
      ...preds.map(p    => ({ type: 'prediction', userId: p.user_id,  matchId: p.match_id, detail: `Predicted ${p.predicted_winner}`,              sport: p.sport, at: p.created_at })),
      ...users.map(u    => ({ type: 'signup',      userId: u.id,                            detail: u.display_name ? `${u.display_name} joined` : 'New user joined', at: u.created_at })),
      ...comments.map(c => ({ type: 'comment',     userId: c.user_id,  matchId: c.match_id, detail: (c.content || '').slice(0, 70),                                at: c.created_at })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);

    return res.json({ activities });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Per-match Prediction Stats ────────────────────────────────
router.get('/admin/match-stats/:matchId', adminAuth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const [pollRes, predsRes] = await Promise.all([
      supabase.from('match_prediction_stats').select('*').eq('match_id', matchId).maybeSingle(),
      supabase.from('user_match_predictions').select('predicted_winner, result, created_at').eq('match_id', matchId).order('created_at', { ascending: false }),
    ]);
    const predictions = predsRes.data ?? [];
    return res.json({
      poll:        pollRes.data ?? null,
      predictions: {
        total:   predictions.length,
        correct: predictions.filter(p => p.result === 'correct').length,
        wrong:   predictions.filter(p => p.result === 'wrong').length,
        pending: predictions.filter(p => !p.result).length,
        recent:  predictions.slice(0, 10),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── Standings & Highlights (Highlightly-powered) ─────────────
const { getHLLeagueId, HL_FOOTBALL_LEAGUES } = require('../config/highlightlyConfig');
const hl = require('../services/highlightlyService');

router.get('/admin/standings', adminAuth, async (req, res) => {
  const { league = 'ipl' } = req.query;
  const l = ALL_LEAGUES[league];
  if (!l) return res.status(400).json({ error: 'Unknown league' });
  try {
    const season = Number(String(l.season).split('/')[0]) || new Date().getFullYear();
    if (l.sport === 'football') {
      const fl = HL_FOOTBALL_LEAGUES[String(league)];
      if (!fl?.id) return res.status(404).json({ error: `No Highlightly ID for football league ${league}` });
      const data = await hl.getFootballStandings(fl.id, String(season));
      return res.json({ league, season, sport: 'football', data });
    } else {
      const hlId = getHLLeagueId(String(league), season);
      if (!hlId) return res.status(404).json({ error: `No Highlightly ID for ${league} ${season}` });
      const data = await hl.getStandings(hlId, String(season));
      return res.json({ league, season, sport: 'cricket', data });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/admin/highlights', adminAuth, async (req, res) => {
  const { league, limit = '20', sport } = req.query;
  try {
    const lim = Math.min(Number(limit), 50);
    const leagueConfig = league ? ALL_LEAGUES[String(league)] : null;
    const isFoot = leagueConfig?.sport === 'football' || sport === 'football';

    if (isFoot) {
      const params = { limit: lim };
      if (leagueConfig) {
        const fl = HL_FOOTBALL_LEAGUES[String(league)];
        if (fl?.id) params.leagueId = fl.id;
      }
      const data = await hl.getFootballHighlights(params);
      return res.json({ highlights: Array.isArray(data) ? data : [], sport: 'football' });
    } else {
      const params = { limit: lim };
      if (leagueConfig) {
        const season = Number(String(leagueConfig.season).split('/')[0]) || new Date().getFullYear();
        const hlId = getHLLeagueId(String(league), season);
        if (hlId) params.leagueId = hlId;
      }
      const data = await hl.getHighlights(params);
      return res.json({ highlights: Array.isArray(data) ? data : [], sport: 'cricket' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
