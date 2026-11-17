require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const jobsRouter = require("./routes/jobs");
const crawlerRouter = require("./crawlers/crawler-route");
const adminRouter = require("./routes/admin");
const { runQuickCrawl, runFullCrawl, noteBootCrawl } = require("./crawlers/index");
const { getJobCount } = require("./services/db");

const app = express();
const PORT = process.env.PORT || 3001;

// Railway/Vercel sit behind a proxy — needed for correct client IPs (rate limiting)
app.set("trust proxy", 1);

// ─── CORS — actually enforce the allowed list ─────────────────
const allowedOrigins = [
  "https://goojob.io",
  "https://www.goojob.io",
  "http://localhost:5173",
];
app.use(cors({
  origin: function (origin, callback) {
    // allow non-browser tools (curl, server-to-server) that send no origin
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith(".vercel.app") ||
      (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL)
    ) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
}));

// Cap request body size — nothing legitimate here is large
app.use(express.json({ limit: "100kb" }));

// ─── Rate limiting ────────────────────────────────────────────
// General public API limit
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
}));

// Stricter limit specifically on admin crawl endpoints
app.use("/api/crawler", rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many crawl requests." },
}));

// ─── Routes ───────────────────────────────────────────────────
app.use("/api/jobs", jobsRouter);
app.use("/api/crawler", crawlerRouter);
app.use("/api/admin", adminRouter);
app.get("/", (req, res) => res.json({ status: "Goojob API 🚀" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Cron Schedule ────────────────────────────────────────────
// In-process cron. A Railway restart used to wait up to six hours for the
// next tick, and a second crawl could start while the first was still going.
// The lock lives in the crawler. Boot runs one quick crawl unless opted out.
cron.schedule("0 */6 * * *", () => {
  console.log("[CRON] Quick crawl starting...");
  runQuickCrawl().catch((err) => console.error("[CRON] quick", err.message));
});
cron.schedule("0 2 * * *", () => {
  console.log("[CRON] Full crawl starting...");
  runFullCrawl().catch((err) => console.error("[CRON] full", err.message));
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Goojob running on port ${PORT}`);
  // Warm the index-size cache so the first search doesn't wait on a count.
  getJobCount().catch(() => {});
  if (process.env.CRAWL_ON_BOOT !== "false") {
    noteBootCrawl();
    setTimeout(() => {
      console.log("[CRON] Boot crawl starting");
      runQuickCrawl().catch((err) => console.error("[CRON] boot", err.message));
    }, 20000);
  }
});
