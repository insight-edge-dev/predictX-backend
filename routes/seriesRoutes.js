const express    = require("express");
const controller = require("../controllers/seriesController");

const router = express.Router();

// Specific sub-routes before parameterised /:id
router.get("/series",               controller.getSeriesList);
router.get("/series/:id/matches",   controller.getSeriesMatches);
router.get("/series/:id/table",     controller.getSeriesTable);
router.get("/series/:id",           controller.getSeriesById);

module.exports = router;
