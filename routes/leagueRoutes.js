const express    = require("express");
const controller = require("../controllers/leagueController");

const router = express.Router();

router.get("/leagues",                      controller.listLeagues);
router.get("/leagues/:slug/seasons",        controller.getSeasons);
router.get("/leagues/:slug/matches",        controller.getMatches);
router.get("/leagues/:slug/live",           controller.getLive);
router.get("/leagues/:slug/upcoming",       controller.getUpcoming);
router.get("/leagues/:slug/results",        controller.getResults);
router.get("/leagues/:slug/fixtures",       controller.getFixtures);
router.get("/leagues/:slug/table",          controller.getTable);
router.get("/leagues/:slug/teams",          controller.getTeams);
router.get("/leagues/:slug/highlights",     controller.getHighlights);

module.exports = router;
