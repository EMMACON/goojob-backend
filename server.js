require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const jobsRouter = require("./routes/jobs");
const crawlerRouter = require("./crawlers/crawler-route");
const { runQuickCrawl, runFullCrawl } = require("./crawlers/index");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS — allow your live domains + localhost for dev ───────
const allowedOrigins = [
  "https://goojob.io",
  "https://www.goojob.io",
  "http://localhost:5173",
];
// Also allow any *.vercel.app preview deployments
app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (mobile apps, curl, hoppscotch)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
      return callback(null, true);
    }
    // If FRONTEND_URL env is set, allow that too
    if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) {
      return callback(null, true);
    }
    return callback(null, true); // be permissive — this is a public job board
  },
}));

app.use(express.json());
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 60 }));

// ─── Routes ───────────────────────────────────────────────────
app.use("/api/jobs", jobsRouter);
app.use("/api/crawler", crawlerRouter);
app.get("/", (req, res) => res.json({ status: "Goojob API 🚀" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Cron Schedule ────────────────────────────────────────────
cron.schedule("0 */6 * * *", () => {
  console.log("[CRON] Quick crawl starting...");
  runQuickCrawl().catch(console.error);
});
cron.schedule("0 2 * * *", () => {
  console.log("[CRON] Full crawl starting...");
  runFullCrawl().catch(console.error);
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Goojob running on port ${PORT}`);
});
