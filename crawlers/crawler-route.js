const express = require("express");
const router = express.Router();
const { runFullCrawl, runQuickCrawl, crawlOne } = require("./index");

// Admin key middleware
function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * POST /api/crawler/full
 * Trigger a full crawl of Greenhouse + Lever + Ashby
 * Takes 30-60 mins. Runs in background, responds immediately.
 */
router.post("/full", requireAdminKey, (req, res) => {
  res.json({
    message: "Full crawl started in background",
    note: "Covers Greenhouse (~5000 companies), Lever (~3000), Ashby (~2000)",
    estimatedTime: "30-60 minutes",
  });
  runFullCrawl().catch((e) => console.error("[FULL CRAWL ERROR]", e.message));
});

/**
 * POST /api/crawler/quick
 * Quick crawl of Lever + Ashby only (JSON APIs, 2-5 mins)
 * This is what the cron job calls every 6 hours
 */
router.post("/quick", requireAdminKey, (req, res) => {
  res.json({ message: "Quick crawl started (Lever + Ashby)" });
  runQuickCrawl().catch((e) => console.error("[QUICK CRAWL ERROR]", e.message));
});

/**
 * POST /api/crawler/one
 * Crawl a single company
 * Body: { platform: "lever"|"greenhouse"|"ashby", slug: "linear" }
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
