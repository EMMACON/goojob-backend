const express = require("express");
const router = express.Router();
const { searchJobs, getJobById, getFeaturedJobs, getRecentJobs, getJobCount, logClick } = require("../services/db");
const { parseSearchQuery, hasSearchIntent } = require("../services/search");

// ─── Tuning ───────────────────────────────────────────────────
const PAGE_SIZE = 25;

/**
 * GET /api/jobs/search
 *
 * Finds direct-apply jobs already in the index. Matching is whole-word
 * (with a small set of real variants: accountant/accounting, nurse/nursing).
 * Title hits outrank company hits. Description-only hits are not results.
 *
 * Query parameters — all optional except that at least one of q, location,
 * type, or remote must narrow the search:
 *
 *   q         Free text. Job words are matched on the title and company.
 *             These words are NOT plain keywords; they change the search:
 *               remote, wfh, work from home, anywhere  → remote jobs only
 *               onsite, on-site, in office             → on-site jobs only
 *               hybrid                                 → title or location says hybrid
 *               intern, internship                     → internships only
 *             A known city or country is a location filter, not a keyword.
 *             "accountant Accra" searches accountant roles in Accra.
 *             "remote marketing" searches marketing roles that are remote.
 *   location  City or country. Same filter as a place typed in q.
 *             A city in q is ignored when location is set explicitly.
 *   remote    "true" or "false". Wins over remote/onsite words in q.
 *   type      Full-time | Part-time | Contract | Internship.
 *   page      Page number, 25 jobs per page. Response includes hasMore.
 *
 * Response (existing fields kept; new fields are additive):
 *   jobs, total, page, pageSize, hasMore, directCount, aggregatorCount,
 *   upgradedCount, source, parsed, indexSize, freshCount, truncated
 *
 * indexSize / freshCount also live at GET /api/jobs/count.
 * aggregatorCount and upgradedCount stay in the payload for older clients.
 * Search no longer calls Remotive, RemoteOK, Arbeitnow, Adzuna, or live ATS
 * resolvers. Those calls ran during the request (multi-second timeouts,
 * several hosts per company) and were the 2s–12s tail. Almost every
 * aggregator row was then dropped by the direct-link rule.
 *
 * GET /api/jobs/count
 *   { total, fresh, maxAgeDays, asOf }
 *   total is every row in the index. fresh is posted within maxAgeDays,
 *   which is the set search will actually return.
 *
 * GET /api/jobs/recent
 *   Newest jobs for the homepage. At most 3 per company, and the same
 *   title at one company is returned once with its locations combined.
 *
 * GET /api/jobs/featured
 * GET /api/jobs/:id
 * POST /api/jobs/:id/click
 */
router.get("/search", async (req, res) => {
  const started = Date.now();
  try {
    const { q = "", location = "", type = "", remote, page = 1 } = req.query;
    const parsed = parseSearchQuery({ q, location, type, remote });

    if (!hasSearchIntent(parsed)) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const [direct, count] = await Promise.all([
      searchJobs({
        query: q,
        location,
        type,
        remote,
        page: pageNum,
        limit: PAGE_SIZE,
      }),
      getJobCount().catch(() => null),
    ]);

    const jobs = (direct.jobs || []).map((job) => (
      job.source_type ? job : { ...job, source_type: "direct" }
    ));
    const total = direct.total || 0;
    const hasMore = jobs.length >= PAGE_SIZE && pageNum * PAGE_SIZE < total;

    if (Date.now() - started > 1500) {
      console.error(`[search] slow ${Date.now() - started}ms q=${JSON.stringify(String(q).slice(0, 80))}`);
    }

    return res.json({
      jobs,
      total,
      page: pageNum,
      pageSize: PAGE_SIZE,
      hasMore,
      directCount: jobs.length,
      aggregatorCount: 0,
      upgradedCount: 0,
      source: "direct",
      parsed: direct.parsed || parsed,
      indexSize: count ? count.total : null,
      freshCount: count ? count.fresh : null,
      truncated: Boolean(direct.truncated),
    });
  } catch (err) {
    console.error("[/search]", err.message);
    res.status(500).json({ error: "Search failed. Please try again." });
  }
});

/**
 * GET /api/jobs/count
 * Index size for a truthful "N jobs" claim. Cached for a few minutes.
 */
router.get("/count", async (req, res) => {
  try {
    const data = await getJobCount();
    res.json(data);
  } catch (err) {
    console.error("[/count]", err.message);
    res.status(500).json({ error: "Could not count jobs." });
  }
});

/**
 * GET /api/jobs/recent
 * Newest fresh jobs across companies — shown on the homepage
 * before the user searches anything. Capped per company.
 */
router.get("/recent", async (req, res) => {
  try {
    const [data, count] = await Promise.all([
      getRecentJobs(40),
      getJobCount().catch(() => null),
    ]);
    res.json({
      ...data,
      jobs: (data.jobs || []).map((job) => ({ ...job, source_type: "direct" })),
      indexSize: count ? count.total : null,
      freshCount: count ? count.fresh : null,
    });
  } catch (err) {
    console.error("[/recent]", err.message);
    res.status(500).json({ error: "Could not load recent jobs." });
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
