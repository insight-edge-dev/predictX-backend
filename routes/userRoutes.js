const express    = require("express");
const controller = require("../controllers/userController");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

// All user routes require a valid Supabase JWT
router.get("/user/profile",     requireAuth, controller.getProfile);
router.patch("/user/profile",   requireAuth, controller.updateProfile);
router.get("/user/favorites",   requireAuth, controller.getFavorites);
router.post("/user/favorites",  requireAuth, controller.addFavorite);
router.get("/user/teams",       requireAuth, controller.getUserTeams);

module.exports = router;
