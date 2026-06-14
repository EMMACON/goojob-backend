const express = require("express");
const router = express.Router();
const { searchJobs, getJobById, getFeaturedJobs, logClick } = require("../services/db");
const { searchAdzuna, isConfigured: adzunaReady } = require("../services/adzuna");
const { searchRemoteSources } = require("../services/remote-sources");
const { resolveBatch } = require("../services/link-resolver");

// ─── Tuning ───────────────────────────────────────────────────
// Adzuna ONLY fills gaps. If we already have plenty of direct jobs,
// we don't call Adzuna at all. When we do, we cap how many show so
// it can never bury your direct (badged) jobs.
const DIRECT_ENOUGH = 8;   // if direct results >= this, skip Adzuna entirely
const ADZUNA_MAX = 6;      // never show more than this many Adzuna jobs

/**
 * GET /api/jobs/search
 *
 * 1. Search OUR crawled jobs first (direct company links) — always priority.
 * 2. ONLY if direct results are thin (< DIRECT_ENOUGH), top up with a
 *    capped number of Adzuna jobs (badged "Via Adzuna"), biased to remote
 *    since the audience is global. Direct jobs always shown first.
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

    // 2) Gap-fill — ONLY when direct results are thin.
    //    Order of preference: remote-native sources (lean direct) FIRST,
    //    then Adzuna as the last-resort filler. All capped & deduped.
    let aggregatorJobs = [];
    const needsTopUp = directJobs.length < DIRECT_ENOUGH;

    if (needsTopUp) {
      const remoteWanted = remoteFilter === false ? false : true;
      const seen = new Set(
        directJobs.map((j) => `${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`)
      );

      // 2a) Remote-native sources first (Remotive, RemoteOK, Arbeitnow)
      try {
        const remoteRes = await searchRemoteSources({ query: q, remote: remoteFilter, limit: 15 });
        for (const j of remoteRes.jobs) {
          const key = `${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            aggregatorJobs.push({ ...j, source_type: "aggregator" });
          }
        }
      } catch (e) {
        console.error("[remote-sources]", e.message);
      }

      // 2b) Adzuna only if we STILL need more after remote sources
      if (adzunaReady() && directJobs.length + aggregatorJobs.length < DIRECT_ENOUGH) {
        const adzRemote = remoteWanted;
        const adz = await searchAdzuna({ query: q, remote: adzRemote, page: pageNum, limit: 20 });
        for (const j of (adz.jobs || [])) {
          const key = `${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            aggregatorJobs.push({ ...j, source_type: "aggregator" });
          }
        }
      }

      // Cap total filler, then try to UPGRADE each to a real direct link
      aggregatorJobs = aggregatorJobs.slice(0, ADZUNA_MAX);
      aggregatorJobs = await resolveBatch(aggregatorJobs);
    }

    // After resolution, some aggregator jobs may have been upgraded to
    // "direct". Re-split so ALL direct jobs (crawled + upgraded) come
    // first, and only genuine Adzuna jobs are badged as aggregator.
    const upgradedDirect = aggregatorJobs.filter((j) => j.source_type === "direct");
    const stillAggregator = aggregatorJobs.filter((j) => j.source_type === "aggregator");

    const jobs = [...directJobs, ...upgradedDirect, ...stillAggregator];

    return res.json({
      jobs,
      total: (direct.total || 0) + stillAggregator.length,
      directCount: directJobs.length + upgradedDirect.length,
      aggregatorCount: stillAggregator.length,
      upgradedCount: upgradedDirect.length,
      page: pageNum,
      source: stillAggregator.length || upgradedDirect.length ? "direct+adzuna" : "direct",
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
    const id = String(req.params.id);
    if (/^(adzuna_|remotive_|remoteok_|arbeitnow_)/.test(id)) {
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
 */
router.post("/:id/click", async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!/^(adzuna_|remotive_|remoteok_|arbeitnow_)/.test(id)) {
      const userIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      await logClick(req.params.id, userIp);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not log click." });
  }
});

module.exports = router;
