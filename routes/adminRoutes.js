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
router.get("/admin/users",    adminAuth, ctrl.listUsersAdmin);

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

router.get   ("/admin/comments",     adminAuth, ctrl.listCommentsAdmin);
router.delete("/admin/comments/:id", adminAuth, ctrl.deleteCommentAdmin);

// ── Prediction resolution ──────────────────────────────────────
// POST /api/admin/resolve-match          → manual single-match resolve
// POST /api/admin/resolve-scan           → trigger the auto-scan now

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

module.exports = router;
