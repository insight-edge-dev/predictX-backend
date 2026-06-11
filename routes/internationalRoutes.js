const express    = require("express");
const controller = require("../controllers/internationalController");

const router = express.Router();

// /tips/:matchId must come before /series/:stageId — different resource, no clash,
// but kept explicit so route order stays predictable as this grows.
router.get("/international/series",            controller.getSeriesList);
router.get("/international/series/:stageId",   controller.getSeriesDetail);
router.get("/international/tips/:matchId",     controller.getMatchTip);

module.exports = router;
