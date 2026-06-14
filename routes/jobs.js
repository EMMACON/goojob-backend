const express = require("express");
const router = express.Router();
const { searchJobs, getJobById, getFeaturedJobs, logClick } = require("../services/db");
const { searchAdzuna, isConfigured: adzunaReady } = require("../services/adzuna");

/**
 * GET /api/jobs/search
 *
 * Strategy:
 *   1. Always search OUR crawled jobs first (direct company links).
 *      These are prioritized and badged "Direct" on the frontend.
 *   2. Then top up with Adzuna aggregator results (broad sector
 *      coverage) badged "Via Adzuna", so sectors like video editing
 *      aren't empty. Deduped and always shown AFTER direct jobs.
 */
router.get("/search", async (req, res) => {
  try {
    const { q = "", location = "", type = "", remote, page = 1 } = req.query;

    if (!q.trim()) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const remoteFilter = remote === "true" ? true : remote === "false" ? false : undefined;
    const pageNum = Number(page) || 1;

    // 1) Our direct crawled jobs (priority)
    const direct = await searchJobs({
      query: q,
      location,
      type,
      remote: remoteFilter,
      page: pageNum,
      limit: 20,
    });

    let directJobs = (direct.jobs || []).map((j) => ({ ...j, source_type: "direct" }));

    // 2) Adzuna top-up (only if configured). We fetch broad results
    //    and append them after the direct jobs.
    let aggregatorJobs = [];
    let aggregatorTotal = 0;
    if (adzunaReady()) {
      const adz = await searchAdzuna({
        query: q,
        remote: remoteFilter,
        page: pageNum,
        limit: 20,
      });
      aggregatorTotal = adz.total || 0;

      // Dedupe: drop aggregator jobs whose title+company already
      // appear in our direct results (case-insensitive).
      const seen = new Set(
        directJobs.map((j) => `${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`)
      );
      aggregatorJobs = (adz.jobs || [])
        .filter((j) => !seen.has(`${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`))
        .map((j) => ({ ...j, source_type: "aggregator" }));
    }

    // Direct jobs always first, aggregator fills the rest
    const jobs = [...directJobs, ...aggregatorJobs];

    return res.json({
      jobs,
      total: (direct.total || 0) + aggregatorTotal,
      directCount: directJobs.length,
      aggregatorCount: aggregatorJobs.length,
      page: pageNum,
      source: adzunaReady() ? "direct+adzuna" : "direct",
    });
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
    // Aggregator jobs aren't in our DB; their full data already came
    // from search. Only look up real DB ids here.
    if (String(req.params.id).startsWith("adzuna_")) {
      return res.status(404).json({ error: "External job — apply via its link." });
    }
    const job = await getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch job." });
  }
});

/**
 * POST /api/jobs/:id/click
 * (only logs clicks for our own DB jobs; aggregator clicks are skipped)
 */
router.post("/:id/click", async (req, res) => {
  try {
    if (!String(req.params.id).startsWith("adzuna_")) {
      const userIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      await logClick(req.params.id, userIp);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not log click." });
  }
});

module.exports = router;
