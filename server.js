require("dotenv").config();

const http    = require("http");
const express = require("express");
const cors    = require("cors");

const footballRoutes   = require("./routes/footballRoutes");
const matchRoutes      = require("./routes/matchRoutes");
const adminRoutes      = require("./routes/adminRoutes");
const adminAuth        = require("./middleware/adminAuth");
const publicContentRoutes = require("./routes/publicContentRoutes");
const seriesRoutes     = require("./routes/seriesRoutes");
const playerRoutes     = require("./routes/playerRoutes");
const userRoutes       = require("./routes/userRoutes");
const iplRoutes        = require("./routes/iplRoutes");
const leagueRoutes     = require("./routes/leagueRoutes");
const tipsRoutes       = require("./routes/tipsRoutes");
const homeRoutes       = require("./routes/homeRoutes");
const predictionRoutes = require("./routes/predictionRoutes");
const smsRoutes        = require("./routes/smsRoutes");
const authRoutes       = require("./routes/authRoutes");
const venueRoutes      = require("./routes/venueRoutes");
const internationalRoutes = require("./routes/internationalRoutes");

const { getStats, flushCache }    = require("./services/cacheService");
const { resetIPLCache, getIPLFixtures } = require("./services/iplService");
const db                          = require("./services/dbService");
const wsService                   = require("./services/wsService");
const footballService             = require("./services/footballService");
const footballScheduler           = require("./services/footballSchedulerService");
const predictionScheduler         = require("./services/predictionSchedulerService");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(o => o.trim())
  : ["http://localhost:5173", "http://localhost:3000"];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────

app.use("/api", footballRoutes);
app.use("/api", smsRoutes);
app.use("/api", authRoutes);
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
app.use("/api", venueRoutes);
app.use("/api", internationalRoutes);

// ── Health check ──────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString(), cache: getStats() });
});

// ── Admin: flush all caches ───────────────────────────────────

app.post("/admin/cache/flush", adminAuth, async (_req, res) => {
  flushCache();
  await resetIPLCache();
  res.json({ message: "all caches flushed" });
});

// ── Admin: force-refresh IPL fixtures from Sportsmonks ───────

app.post("/admin/refresh-fixtures", adminAuth, async (_req, res) => {
  try {
    await resetIPLCache();
    const fixtures = await getIPLFixtures();
    res.json({ message: `fixtures refreshed — ${fixtures.length} matches loaded` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: force-refresh football fixtures/standings from football-data.org ──

app.post("/admin/refresh-football", adminAuth, async (_req, res) => {
  try {
    const result = await footballService.refreshFromAPI();
    res.json({ message: `football data refreshed — ${result.fixtures} fixtures, ${result.groups} groups synced`, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: reset match/squad/scorecard DB data ────────────────

app.post("/admin/reset-matches", adminAuth, async (_req, res) => {
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

app.post("/admin/fix-empty-squads", adminAuth, async (_req, res) => {
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

app.get("/admin/probe-fixture/:id", adminAuth, async (req, res) => {
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
  console.log(`[Server] APIFOOTBALL_KEY:    ${process.env.APIFOOTBALL_KEY ? process.env.APIFOOTBALL_KEY.slice(0, 8) + "…" : "MISSING (football degraded)"}`);

  wsService.init(server);
  footballScheduler.start();
  predictionScheduler.start();
});
