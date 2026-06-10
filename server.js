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

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 60 }));

// ─── Routes ───────────────────────────────────────────────────
app.use("/api/jobs", jobsRouter);
app.use("/api/crawler", crawlerRouter);
app.get("/", (req, res) => res.json({ status: "Goojob API 🚀" }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Cron Schedule ────────────────────────────────────────────
// Quick crawl (Lever + Ashby JSON APIs) — every 6 hours
cron.schedule("0 */6 * * *", () => {
  console.log("[CRON] Quick crawl starting...");
  runQuickCrawl().catch(console.error);
});

// Full crawl (Greenhouse HTML + Lever + Ashby) — every day at 2am
cron.schedule("0 2 * * *", () => {
  console.log("[CRON] Full crawl starting...");
  runFullCrawl().catch(console.error);
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Goojob running on port ${PORT}`);
  console.log(`   Quick crawl: every 6 hours`);
  console.log(`   Full crawl:  daily at 2am`);
});
