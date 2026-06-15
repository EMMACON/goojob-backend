const express = require("express");
const router = express.Router();
const { searchJobs, getJobById, getFeaturedJobs, logClick } = require("../services/db");
const { searchAdzuna, isConfigured: adzunaReady } = require("../services/adzuna");
const { searchRemoteSources } = require("../services/remote-sources");
const { resolveBatch } = require("../services/link-resolver");

// ─── Tuning ───────────────────────────────────────────────────
const PAGE_SIZE = 25;       // jobs shown per page
const DIRECT_ENOUGH = PAGE_SIZE; // if direct fills the page, skip gap-fill

/**
 * GET /api/jobs/search?q=...&page=1
 *
 * Paginated. Each page returns up to PAGE_SIZE jobs:
 *   1. OUR direct crawled jobs first (always priority, badged Direct)
 *   2. If the page isn't full, top up with remote-native sources
 *      (Remotive/RemoteOK/Arbeitnow), then Adzuna as last resort.
 *   3. Gap-fill jobs are run through the resolver to upgrade them to
 *      real direct company links where possible.
 * Returns `hasMore` so the frontend can show a "Load more" button.
 */
router.get("/search", async (req, res) => {
  try {
    const { q = "", location = "", type = "", remote, page = 1 } = req.query;

    if (!q.trim()) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const remoteFilter = remote === "true" ? true : remote === "false" ? false : undefined;
    const pageNum = Math.max(1, Number(page) || 1);

    // 1) Our direct crawled jobs for this page
    const direct = await searchJobs({
      query: q,
      location,
      type,
      remote: remoteFilter,
      page: pageNum,
      limit: PAGE_SIZE,
    });

    let directJobs = (direct.jobs || []).map((j) => ({ ...j, source_type: "direct" }));
    const directTotal = direct.total || 0;

    // 2) Gap-fill if this page isn't full of direct jobs
    let aggregatorJobs = [];
    let aggregatorTotal = 0;
    const slotsLeft = PAGE_SIZE - directJobs.length;

    if (slotsLeft > 0) {
      const seen = new Set(
        directJobs.map((j) => `${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`)
      );

      // Offset gap-fill by how many direct jobs exist beyond this page,
      // so paging through doesn't repeat the same filler jobs.
      const directPagesConsumed = directTotal; // total direct across all pages
      const fillOffset = Math.max(0, (pageNum - 1) * PAGE_SIZE - directPagesConsumed);

      // 2a) Remote-native sources first
      try {
        const remoteRes = await searchRemoteSources({
          query: q,
          remote: remoteFilter,
          limit: slotsLeft,
          offset: fillOffset,
        });
        aggregatorTotal += remoteRes.total || 0;
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

      // 2b) Adzuna only if still room
      if (adzunaReady() && aggregatorJobs.length < slotsLeft) {
        const adzRemote = remoteFilter === false ? false : true;
        const adz = await searchAdzuna({ query: q, remote: adzRemote, page: pageNum, limit: PAGE_SIZE });
        aggregatorTotal += adz.total || 0;
        for (const j of (adz.jobs || [])) {
          const key = `${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`;
          if (!seen.has(key)) {
            seen.add(key);
            aggregatorJobs.push({ ...j, source_type: "aggregator" });
          }
        }
      }

      // Trim to remaining slots, then upgrade to direct links where possible
      aggregatorJobs = aggregatorJobs.slice(0, slotsLeft);
      aggregatorJobs = await resolveBatch(aggregatorJobs);

      // DIRECT-ONLY POLICY: keep ONLY jobs that resolved to a real
      // company link. Anything still pointing at an aggregator
      // (Adzuna/Remotive/etc.) is dropped — we never show middleman
      // links. This guarantees every job on the site is direct.
      aggregatorJobs = aggregatorJobs.filter((j) => j.source_type === "direct");
    }

    // Everything that survives is now a direct link (crawled OR
    // resolved-from-aggregator). They all get the "direct" treatment.
    const upgradedDirect = aggregatorJobs; // already filtered to direct only
    const jobs = [...directJobs, ...upgradedDirect];

    // HONEST COUNT: report the number of real direct jobs available.
    // directTotal already reflects post-filter (fresh + relevant) DB jobs.
    // We add only the upgraded aggregator jobs actually shown this page —
    // we do NOT count raw aggregator totals, since most get dropped by the
    // direct-only filter and would inflate the number misleadingly.
    const grandTotal = directTotal + upgradedDirect.length;
    const hasMore = directJobs.length >= PAGE_SIZE && (pageNum * PAGE_SIZE) < directTotal;

    return res.json({
      jobs,
      total: grandTotal,
      page: pageNum,
      pageSize: PAGE_SIZE,
      hasMore,
      directCount: jobs.length,
      aggregatorCount: 0,
      upgradedCount: upgradedDirect.length,
      source: "direct",
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
