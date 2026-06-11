const sm = require("../services/sportmonksService");
const { normalizeVenue } = require("../services/sportmonksNormalizer");
const { getCache, setCache, TTL } = require("../services/cacheService");

async function getVenueById(req, res) {
  const { id } = req.params;
  if (!id || !/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid venue id" });

  const cacheKey = `venue:${id}`;
  const mem = getCache(cacheKey);
  if (mem) return res.json({ venue: mem });

  try {
    const raw = await sm.getVenue(id);
    if (!raw) return res.status(404).json({ error: "Venue not found" });

    const venue = normalizeVenue(raw);
    setCache(cacheKey, venue, TTL.DAILY);
    return res.json({ venue });
  } catch (e) {
    console.error("[Venue] error:", e.message);
    return res.status(500).json({ error: "Failed to fetch venue" });
  }
}

module.exports = { getVenueById };
