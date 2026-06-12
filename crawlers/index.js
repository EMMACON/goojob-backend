const { runGreenhouseCrawler } = require("./greenhouse");
const { runLeverCrawler, discoverNewLeverCompanies } = require("./lever");
const { runAshbyCrawler } = require("./ashby");

// ─────────────────────────────────────────────────────────────
// MASTER CRAWLER ORCHESTRATOR
// Replace the old services/crawler.js with this file.
// Coordinates Greenhouse + Lever + Ashby crawlers.
//
// Estimated coverage:
//   Greenhouse:  ~5,000 companies, ~50,000+ jobs
//   Lever:       ~3,000 companies, ~30,000+ jobs
//   Ashby:       ~2,000 companies, ~15,000+ jobs
//   Total:       ~10,000 companies, ~100,000+ jobs
// ─────────────────────────────────────────────────────────────

/**
 * Full crawl — runs all three platforms.
 * Takes ~30-60 mins for full run. Schedule via cron.
 */
async function runFullCrawl({ onProgress } = {}) {
  console.log("🚀 [MASTER CRAWLER] Starting full crawl...");
  const startTime = Date.now();
  const summary = {};

  // ── 1. Ashby (fastest, clean JSON API) ───────────────────
  console.log("\n📋 [1/3] Crawling Ashby...");
  summary.ashby = await runAshbyCrawler({ onProgress }).catch((e) => ({
    error: e.message, totalJobs: 0,
  }));

  // ── 2. Lever (JSON API, very reliable) ───────────────────
  console.log("\n📋 [2/3] Crawling Lever...");

  // First discover any new companies
  const newLeverSlugs = await discoverNewLeverCompanies().catch(() => []);
  summary.lever = await runLeverCrawler({
    slugs: undefined, // uses default LEVER_COMPANIES + discovered
    onProgress,
  }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  // ── 3. Greenhouse (HTML scraping, most companies) ─────────
  console.log("\n📋 [3/3] Crawling Greenhouse...");
  summary.greenhouse = await runGreenhouseCrawler({
    limit: 500, // first run: 500 companies. Increase to 5000 after testing.
    onProgress,
  }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  const totalJobs =
    (summary.ashby?.totalJobs || 0) +
    (summary.lever?.totalJobs || 0) +
    (summary.greenhouse?.totalJobs || 0);

  const duration = Math.round((Date.now() - startTime) / 1000);

  console.log(`
✅ [MASTER CRAWLER] Done in ${duration}s
   Ashby:       ${summary.ashby?.totalJobs || 0} jobs
   Lever:       ${summary.lever?.totalJobs || 0} jobs
   Greenhouse:  ${summary.greenhouse?.totalJobs || 0} jobs
   ─────────────────────────────
   Total:       ${totalJobs} jobs
  `);

  return { summary, totalJobs, durationSeconds: duration };
}

/**
 * Quick crawl — only Lever + Ashby (JSON APIs, fast).
 * Use this for the every-6-hour cron job.
 * Greenhouse HTML crawl runs separately once/day.
 */
async function runQuickCrawl() {
  console.log("⚡ [QUICK CRAWL] Running Lever + Ashby...");
  const [lever, ashby] = await Promise.allSettled([
    runLeverCrawler(),
    runAshbyCrawler(),
  ]);

  return {
    lever: lever.value || { error: lever.reason?.message },
    ashby: ashby.value || { error: ashby.reason?.message },
  };
}

/**
 * Single company crawl by platform + slug
 * e.g. crawlOne("lever", "linear")
 */
async function crawlOne(platform, slug) {
  const { crawlGreenhouseBoard } = require("./greenhouse");
  const { crawlLeverCompany } = require("./lever");
  const { crawlAshbyCompany } = require("./ashby");
  const { upsertJobs } = require("../services/db");

  let jobs = [];
  if (platform === "greenhouse") jobs = await crawlGreenhouseBoard(slug);
  else if (platform === "lever") jobs = await crawlLeverCompany(slug);
  else if (platform === "ashby") jobs = await crawlAshbyCompany(slug);
  else throw new Error(`Unknown platform: ${platform}`);

  if (jobs.length) await upsertJobs(jobs);
  return { platform, slug, count: jobs.length };
}

module.exports = { runFullCrawl, runQuickCrawl, crawlOne };
