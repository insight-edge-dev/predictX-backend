/**
 * predictionRoutes.js
 *
 * GET /api/predictions/:matchId
 *   Returns pre-match batting score predictions for both teams.
 *   Squad data is fetched from the /matches/:id/full endpoint
 *   (which already has squad) — no extra API calls needed.
 */

const express = require("express");
const { getPredictions } = require("../services/predictionService");
const { getMatch, getSquad } = require("../services/dbService");

const router = express.Router();

router.get("/predictions/:matchId", async (req, res) => {
  const { matchId } = req.params;
  if (!/^\w[\w-]*$/.test(matchId)) {
    return res.status(400).json({ error: "Invalid matchId" });
  }

  try {
    const [cachedMatch, cachedSquad] = await Promise.all([
      getMatch(matchId),
      getSquad(matchId),
    ]);

    const team1Info = cachedMatch?.team1 ?? null;
    const team2Info = cachedMatch?.team2 ?? null;
    // Squad may be embedded in match data (Sportsmonks path) or separate
    const squadData = cachedSquad ?? cachedMatch?.squad ?? null;
    const t1Players = squadData?.team1Players ?? [];
    const t2Players = squadData?.team2Players ?? [];

    const predictions = await getPredictions(
      matchId,
      team1Info,
      team2Info,
      t1Players,
      t2Players,
    );

    return res.json(predictions);
  } catch (e) {
    console.error(`[Predictions] ${matchId}:`, e.message);
    return res.status(500).json({ error: "Failed to generate predictions" });
  }
});

module.exports = router;
