const express    = require("express");
const adminAuth  = require("../middleware/adminAuth");
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

module.exports = router;
