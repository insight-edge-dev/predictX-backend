const express = require("express");
const { getTipsList, getMatchTip } = require("../controllers/tipsController");

const router = express.Router();

router.get("/tips",          getTipsList);
router.get("/tips/:matchId", getMatchTip);

module.exports = router;
