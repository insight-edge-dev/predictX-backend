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
router.get("/admin/users",    adminAuth, ctrl.listUsersAdmin);

router.post  ("/admin/banners/upload",  adminAuth, upload.single("image"), ctrl.uploadBannerImage);
router.post  ("/admin/banners",         adminAuth, ctrl.createBanner);
router.get   ("/admin/banners",         adminAuth, ctrl.listBannersAdmin);
router.put   ("/admin/banners/reorder", adminAuth, ctrl.reorderBanners);
router.put   ("/admin/banners/:id",     adminAuth, ctrl.updateBanner);
router.delete("/admin/banners/:id",     adminAuth, ctrl.deleteBanner);

module.exports = router;
