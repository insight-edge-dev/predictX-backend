const express    = require("express");
const controller = require("../controllers/venueController");

const router = express.Router();

router.get("/venues/:id", controller.getVenueById);

module.exports = router;
