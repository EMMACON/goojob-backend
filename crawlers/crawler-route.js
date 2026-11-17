const express = require("express");
const router = express.Router();
const { runFullCrawl, runQuickCrawl, crawlOne, getCrawlState } = require("./index");

// Admin key middleware
function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * GET /api/crawler/status
 * Last crawl timestamps. No secrets. Shows whether the in-process cron has run.
 */
router.get("/status", (req, res) => {
  res.json(getCrawlState());
});

/**
 * POST /api/crawler/full
 * Verified boards plus a 180-day expiry of rows the product will never show.
 * Runs in the background.
 */
router.post("/full", requireAdminKey, (req, res) => {
  res.json({
    message: "Full crawl started in background",
    note: "Verified Greenhouse, Lever, Ashby, Workable, Workday, Oracle, BambooHR, and employer sitemaps. Removes rows older than 180 days at the end.",
  });
  runFullCrawl().catch((e) => console.error("[FULL CRAWL ERROR]", e.message));
});

/**
 * POST /api/crawler/quick
 * Quick crawl of Lever + Ashby only (JSON APIs, 2-5 mins)
 * This is what the cron job calls every 6 hours
 */
router.post("/quick", requireAdminKey, (req, res) => {
  res.json({ message: "Quick crawl started" });
  runQuickCrawl().catch((e) => console.error("[QUICK CRAWL ERROR]", e.message));
});

/**
 * POST /api/crawler/one
 * Crawl a single company
 * Body: { platform: "lever"|"greenhouse"|"ashby"|"workday"|"oracle"|"bamboohr"|"sitemap"|"workable"|"personio"|"recruitee", slug }
 */
router.post("/one", requireAdminKey, async (req, res) => {
  const { platform, slug } = req.body;
  if (!platform || !slug) {
    return res.status(400).json({ error: "platform and slug required" });
  }
  try {
    const result = await crawlOne(platform, slug);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
