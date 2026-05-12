const express    = require("express");
const controller = require("../controllers/leagueController");

const router = express.Router();

router.get("/leagues",                  controller.listLeagues);
router.get("/leagues/:slug/matches",    controller.getMatches);
router.get("/leagues/:slug/live",       controller.getLive);
router.get("/leagues/:slug/upcoming",   controller.getUpcoming);
router.get("/leagues/:slug/results",    controller.getResults);
router.get("/leagues/:slug/fixtures",   controller.getFixtures);
router.get("/leagues/:slug/table",      controller.getTable);

module.exports = router;
