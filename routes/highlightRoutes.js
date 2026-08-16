const express    = require("express");
const controller = require("../controllers/highlightController");

const router = express.Router();

router.get("/highlights/match/:id",  controller.getMatchHighlights);
router.get("/highlights/league/:id", controller.getLeagueHighlights);
router.get("/highlights",            controller.getHighlights);

module.exports = router;
