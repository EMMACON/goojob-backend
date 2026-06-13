const { runGreenhouseCrawler } = require("./greenhouse");
const { runLeverCrawler, discoverNewLeverCompanies } = require("./lever");
const { runAshbyCrawler } = require("./ashby");

// ─────────────────────────────────────────────────────────────
// MASTER CRAWLER ORCHESTRATOR (maxed out for maximum coverage)
//   Greenhouse:  ALL companies in sitemap (~5000+)
//   Lever:       full known list + discovery
//   Ashby:       full known list
// ─────────────────────────────────────────────────────────────

async function runFullCrawl({ onProgress } = {}) {
  console.log("🚀 [MASTER CRAWLER] Starting FULL crawl (maxed)...");
  const startTime = Date.now();
  const summary = {};

  console.log("\n📋 [1/3] Crawling Ashby...");
  summary.ashby = await runAshbyCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 [2/3] Crawling Lever...");
  await discoverNewLeverCompanies().catch(() => []);
  summary.lever = await runLeverCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 [3/3] Crawling Greenhouse (ALL companies)...");
  // limit 5000 = effectively all companies in the Greenhouse sitemap
  summary.greenhouse = await runGreenhouseCrawler({ limit: 5000, onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  const totalJobs =
    (summary.ashby?.totalJobs || 0) +
    (summary.lever?.totalJobs || 0) +
    (summary.greenhouse?.totalJobs || 0);

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ [MASTER CRAWLER] Done in ${duration}s | Total: ${totalJobs} jobs`);

  return { summary, totalJobs, durationSeconds: duration };
}

async function runQuickCrawl() {
  console.log("⚡ [QUICK CRAWL] Lever + Ashby...");
  const [lever, ashby] = await Promise.allSettled([runLeverCrawler(), runAshbyCrawler()]);
  return {
    lever: lever.value || { error: lever.reason?.message },
    ashby: ashby.value || { error: ashby.reason?.message },
  };
}

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
