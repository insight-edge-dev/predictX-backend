const express = require("express");
const { getTipsList, getMatchTip, getTipsBundle } = require("../controllers/tipsController");

const router = express.Router();

router.get("/tips/bundle",   getTipsBundle);   // must be before /:matchId
router.get("/tips",          getTipsList);
router.get("/tips/:matchId", getMatchTip);

module.exports = router;
