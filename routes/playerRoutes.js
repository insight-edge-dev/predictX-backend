const express    = require("express");
const controller = require("../controllers/playerController");

const router = express.Router();

// /search must come before /:id so it isn't treated as an id
router.get("/players",          controller.getPlayers);
router.get("/players/search",   controller.searchPlayers);
router.get("/players/:id",      controller.getPlayerById);

module.exports = router;
