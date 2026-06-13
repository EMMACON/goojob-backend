const express = require("express");
const router = express.Router();
const { searchJobs, getJobById, getFeaturedJobs, logClick } = require("../services/db");

/**
 * GET /api/jobs/search
 * Searches ONLY our crawled jobs (Greenhouse/Lever/Ashby).
 * Every result is a direct company job link — no middlemen, no job boards.
 *
 * Query params: q, location, type, remote, page
 */
router.get("/search", async (req, res) => {
  try {
    const { q = "", location = "", type = "", remote, page = 1 } = req.query;

    if (!q.trim()) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const remoteFilter = remote === "true" ? true : remote === "false" ? false : undefined;

    const results = await searchJobs({
      query: q,
      location,
      type,
      remote: remoteFilter,
      page: Number(page),
      limit: 20,
    });

    return res.json({ ...results, source: "db" });
  } catch (err) {
    console.error("[/search]", err.message);
    res.status(500).json({ error: "Search failed. Please try again." });
  }
});

/**
 * GET /api/jobs/featured
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
