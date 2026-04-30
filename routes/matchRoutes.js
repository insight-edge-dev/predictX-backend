const express    = require("express");
const controller = require("../controllers/matchController");

const router = express.Router();

// Specific routes BEFORE parameterised /:id routes
router.get("/matches",              controller.getMatches);
router.get("/matches/live",         controller.getLive);
router.get("/matches/upcoming",     controller.getUpcoming);
router.get("/matches/results",      controller.getResults);
router.get("/matches/:id/full",      controller.getMatchFull);
router.get("/matches/:id/scorecard", controller.getMatchScorecard);
router.get("/matches/:id/series",    controller.getMatchSeries);
router.get("/matches/:id/squad",     controller.getMatchSquad);
router.get("/matches/:id/stats",     controller.getMatchStats);
router.get("/matches/:id",           controller.getMatchById);

module.exports = router;
