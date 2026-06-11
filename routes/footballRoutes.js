const express    = require("express");
const controller = require("../controllers/footballController");

const router = express.Router();

// Specific routes before param routes
router.get("/football/wc-history",       controller.getWCHistory);
router.get("/football/matches/live",     controller.getLive);
router.get("/football/matches/upcoming", controller.getUpcoming);
router.get("/football/matches/results",  controller.getResults);
router.get("/football/matches/:id",      controller.getMatchById);
router.get("/football/matches",          controller.getMatches);

router.get("/football/tips/:matchId",    controller.getMatchTip);
router.get("/football/tips",             controller.getTipsList);

router.get("/football/groups/:group",    controller.getGroup);
router.get("/football/groups",           controller.getGroups);

module.exports = router;
