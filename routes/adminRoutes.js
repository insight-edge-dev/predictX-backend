const express    = require("express");
const adminAuth  = require("../middleware/adminAuth");
const upload     = require("../middleware/upload");
const ctrl       = require("../controllers/adminController");

const router = express.Router();

// Each route has adminAuth inline — avoids blocking non-admin routes
router.post  ("/admin/notifications",          adminAuth, ctrl.createNotification);
router.get   ("/admin/notifications",          adminAuth, ctrl.listNotificationsAdmin);
router.delete("/admin/notifications/:id",      adminAuth, ctrl.deleteNotification);

router.post  ("/admin/expert-predictions",     adminAuth, ctrl.createExpertPrediction);
router.get   ("/admin/expert-predictions",     adminAuth, ctrl.listExpertPredictionsAdmin);
router.put   ("/admin/expert-predictions/:id", adminAuth, ctrl.updateExpertPrediction);
router.delete("/admin/expert-predictions/:id", adminAuth, ctrl.deleteExpertPrediction);

router.get("/admin/matches", adminAuth, ctrl.getUpcomingMatchesPicker);

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

module.exports = router;
