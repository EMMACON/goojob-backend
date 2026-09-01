require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const jobsRouter = require("./routes/jobs");
const crawlerRouter = require("./crawlers/crawler-route");
const adminRouter = require("./routes/admin");
const { runQuickCrawl, runFullCrawl } = require("./crawlers/index");

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
