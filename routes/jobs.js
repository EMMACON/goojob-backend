const express = require("express");
const router = express.Router();
const { searchJobs, getJobById, getFeaturedJobs, logClick } = require("../services/db");
const { searchJSearchAPI } = require("../services/jsearch");
const { upsertJobs } = require("../services/db");

/**
 * GET /api/jobs/search
 * Main search endpoint — checks DB first, falls back to JSearch API
 *
 * Query params:
 *   q        - search keyword (required)
 *   location - city/country filter
 *   type     - Full-time | Part-time | Contract | Internship
 *   remote   - true | false
 *   page     - page number (default 1)
 */
router.get("/search", async (req, res) => {
  try {
    const { q = "", location = "", type = "", remote, page = 1 } = req.query;

    if (!q.trim()) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const remoteFilter = remote === "true" ? true : remote === "false" ? false : undefined;

    // 1. Check our Supabase DB first (crawled + cached results)
    const dbResults = await searchJobs({
      query: q,
      location,
      type,
      remote: remoteFilter,
      page: Number(page),
      limit: 20,
    });

    // 2. If DB has enough results, return them
    if (dbResults.total >= 10) {
      return res.json({ ...dbResults, source: "db" });
    }

    // 3. Otherwise, hit JSearch API for fresh results
    const apiJobs = await searchJSearchAPI({
      query: q,
      location,
      remote: remoteFilter,
      page: Number(page),
    });

    // 4. Cache API results in Supabase for next time
    if (apiJobs.length) {
      await upsertJobs(apiJobs).catch((e) =>
        console.warn("[CACHE] Failed to cache jobs:", e.message)
      );
    }

    return res.json({
      jobs: apiJobs,
      total: apiJobs.length,
      page: Number(page),
      limit: 20,
      source: "api",
    });
  } catch (err) {
    console.error("[/search]", err.message);
    res.status(500).json({ error: "Search failed. Please try again." });
  }
});

/**
 * GET /api/jobs/featured
 * Returns featured/recent jobs for the homepage
 */
router.get("/featured", async (req, res) => {
  try {
    const jobs = await getFeaturedJobs(12);
    res.json({ jobs });
  } catch (err) {
    console.error("[/featured]", err.message);
    res.status(500).json({ error: "Could not load featured jobs." });
  }
});

/**
 * GET /api/jobs/:id
 * Single job detail
 */
router.get("/:id", async (req, res) => {
  try {
    const job = await getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch job." });
  }
});

/**
 * POST /api/jobs/:id/click
 * Track when a user clicks "Apply" (for analytics only — no redirect)
 */
router.post("/:id/click", async (req, res) => {
  try {
    const userIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    await logClick(req.params.id, userIp);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not log click." });
  }
});

module.exports = router;
