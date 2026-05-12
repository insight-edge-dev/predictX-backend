require("dotenv").config();

const http    = require("http");
const express = require("express");
const cors    = require("cors");

const matchRoutes      = require("./routes/matchRoutes");
const adminRoutes      = require("./routes/adminRoutes");
const publicContentRoutes = require("./routes/publicContentRoutes");
const seriesRoutes     = require("./routes/seriesRoutes");
const playerRoutes     = require("./routes/playerRoutes");
const userRoutes       = require("./routes/userRoutes");
const iplRoutes        = require("./routes/iplRoutes");
const leagueRoutes     = require("./routes/leagueRoutes");
const tipsRoutes       = require("./routes/tipsRoutes");
const homeRoutes       = require("./routes/homeRoutes");
const predictionRoutes = require("./routes/predictionRoutes");

const { getStats, flushCache }    = require("./services/cacheService");
const { resetIPLCache, getIPLFixtures } = require("./services/iplService");
const db                          = require("./services/dbService");
const wsService                   = require("./services/wsService");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────

app.use("/api", adminRoutes);
app.use("/api", publicContentRoutes);
app.use("/api", homeRoutes);
app.use("/api", predictionRoutes);
app.use("/api", leagueRoutes);
app.use("/api", iplRoutes);
app.use("/api", tipsRoutes);
app.use("/api", matchRoutes);
app.use("/api", seriesRoutes);
app.use("/api", playerRoutes);
app.use("/api", userRoutes);

// ── Health check ──────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString(), cache: getStats() });
});

// ── Admin: flush all caches ───────────────────────────────────

app.post("/admin/cache/flush", async (_req, res) => {
  flushCache();
  await resetIPLCache();
  res.json({ message: "all caches flushed" });
});

// ── Admin: force-refresh IPL fixtures from Sportsmonks ───────

app.post("/admin/refresh-fixtures", async (_req, res) => {
  try {
    await resetIPLCache();
    const fixtures = await getIPLFixtures();
    res.json({ message: `fixtures refreshed — ${fixtures.length} matches loaded` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: reset match/squad/scorecard DB data ────────────────

app.post("/admin/reset-matches", async (_req, res) => {
  try {
    flushCache();
    await Promise.all([
      db.deleteAllMatches(),
      db.deleteAllSquads(),
      db.deleteCachedByPrefix("pred:"),
    ]);
    res.json({ message: "matches, squads, and predictions cleared from DB" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: delete squads with no players ─────────────────────

app.post("/admin/fix-empty-squads", async (_req, res) => {
  try {
    const supabase = require("./config/supabase");
    const { data, error } = await supabase.from("squads").select("match_id, data");
    if (error) return res.status(500).json({ error: error.message });

    const emptyIds = (data || [])
      .filter(row => !row.data?.team1Players?.length && !row.data?.team2Players?.length)
      .map(row => row.match_id);

    if (emptyIds.length === 0) return res.json({ message: "no empty squads found" });

    await supabase.from("squads").delete().in("match_id", emptyIds);
    flushCache();
    res.json({ message: `deleted ${emptyIds.length} empty squad(s)`, ids: emptyIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: raw Sportsmonks fixture probe ──────────────────────

app.get("/admin/probe-fixture/:id", async (req, res) => {
  try {
    const sm  = require("./services/sportmonksService");
    const raw = await sm.getFixtureDetail(Number(req.params.id));
    res.json(raw || { error: "not found" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 404 ───────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  console.error("[Server] unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] IPL IQ backend listening on 0.0.0.0:${PORT}`);
  console.log(`[Server] SPORTMONKS_API_KEY: ${process.env.SPORTMONKS_API_KEY ? process.env.SPORTMONKS_API_KEY.slice(0, 8) + "…" : "MISSING"}`);
  console.log(`[Server] CRICBUZZ_API_KEY:   ${process.env.CRICBUZZ_API_KEY   ? process.env.CRICBUZZ_API_KEY.slice(0, 8)   + "…" : "MISSING (news/rankings degraded)"}`);
  console.log(`[Server] SUPABASE_URL:       ${process.env.SUPABASE_URL || "MISSING"}`);

  wsService.init(server);
});
