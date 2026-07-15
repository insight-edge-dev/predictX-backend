const express    = require("express");
const controller = require("../controllers/userController");
const { requireAuth } = require("../middleware/authMiddleware");
const upload     = require("../middleware/upload");

const router = express.Router();

// All user routes require a valid Supabase JWT
router.get("/user/profile",     requireAuth, controller.getProfile);
router.patch("/user/profile",   requireAuth, controller.updateProfile);
router.post("/user/avatar",     requireAuth, upload.single("avatar"), controller.uploadAvatarHandler);
router.get("/user/favorites",   requireAuth, controller.getFavorites);
router.post("/user/favorites",  requireAuth, controller.addFavorite);
router.get("/user/teams",       requireAuth, controller.getUserTeams);

router.post  ("/user/push-token",         requireAuth, controller.registerPushToken);
router.delete("/user/push-token",         requireAuth, controller.removePushToken);
router.get   ("/user/notification-prefs", requireAuth, controller.getNotificationPrefs);
router.put   ("/user/notification-prefs", requireAuth, controller.updateNotificationPrefs);

module.exports = router;
