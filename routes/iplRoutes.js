const express    = require("express");
const controller = require("../controllers/iplController");

const router = express.Router();

// Specific paths before any future parameterised routes
router.get("/ipl/matches",  controller.getMatches);
router.get("/ipl/live",     controller.getLive);
router.get("/ipl/upcoming", controller.getUpcoming);
router.get("/ipl/results",  controller.getResults);
router.get("/ipl/fixtures", controller.getFixtures);
router.get("/ipl/table",    controller.getTable);

module.exports = router;
