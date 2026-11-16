const { runGreenhouseCrawler, PRIORITY_BOARDS } = require("./greenhouse");
const { runLeverCrawler, discoverNewLeverCompanies } = require("./lever");
const { runAshbyCrawler } = require("./ashby");
const { runWorkableCrawler } = require("./workable");
const { runSmartRecruitersCrawler } = require("./smartrecruiters");
const { runRecruiteeCrawler } = require("./recruitee");
const { runManualSheetCrawler } = require("./manual-sheet");
const { runPersonioCrawler } = require("./personio");

// ─────────────────────────────────────────────────────────────
// MASTER CRAWLER ORCHESTRATOR (maxed out for maximum coverage)
//   Greenhouse:  ALL companies in sitemap (~5000+)
//   Lever:       expanded multi-sector list + discovery
//   Ashby:       expanded multi-sector list
//   Workable:    NEW — SMB / non-tech / international employers
// ─────────────────────────────────────────────────────────────

async function runFullCrawl({ onProgress } = {}) {
  console.log("🚀 [MASTER CRAWLER] Starting FULL crawl (maxed)...");
  const startTime = Date.now();
  const summary = {};

  console.log("\n📋 Reading manual job sheet...");
  summary.manual = await runManualSheetCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 Crawling Ashby...");
  summary.ashby = await runAshbyCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 [2/4] Crawling Lever...");
  await discoverNewLeverCompanies().catch(() => []);
  summary.lever = await runLeverCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 Crawling Workable...");
  summary.workable = await runWorkableCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 Crawling SmartRecruiters...");
  summary.smartrecruiters = await runSmartRecruitersCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 Crawling Recruitee...");
  summary.recruitee = await runRecruiteeCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 Crawling Greenhouse priority boards (healthcare, education, learning)...");
  summary.greenhousePriority = await runGreenhouseCrawler({ slugs: PRIORITY_BOARDS, onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 Crawling Personio...");
  summary.personio = await runPersonioCrawler({ onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  console.log("\n📋 Crawling Greenhouse (ALL companies)...");
  summary.greenhouse = await runGreenhouseCrawler({ limit: 100000, onProgress }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  // Priority Greenhouse boards are inside the full sitemap crawl, so they are not added again.
  const totalJobs =
    (summary.manual?.totalJobs || 0) +
    (summary.ashby?.totalJobs || 0) +
    (summary.lever?.totalJobs || 0) +
    (summary.workable?.totalJobs || 0) +
    (summary.smartrecruiters?.totalJobs || 0) +
    (summary.recruitee?.totalJobs || 0) +
    (summary.personio?.totalJobs || 0) +
    (summary.greenhouse?.totalJobs || 0);

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n✅ [MASTER CRAWLER] Done in ${duration}s | Total: ${totalJobs} jobs`);

  return { summary, totalJobs, durationSeconds: duration };
}

async function runQuickCrawl() {
  console.log("⚡ [QUICK CRAWL] Lever + Ashby + Workable + SmartRecruiters + Recruitee + Greenhouse priority + Personio...");
  const [lever, ashby, workable, sr, recruitee, manual, greenhouse, personio] = await Promise.allSettled([
    runLeverCrawler(),
    runAshbyCrawler(),
    runWorkableCrawler(),
    runSmartRecruitersCrawler(),
    runRecruiteeCrawler(),
    runManualSheetCrawler(),
    runGreenhouseCrawler({ slugs: PRIORITY_BOARDS }),
    runPersonioCrawler(),
  ]);
  return {
    lever: lever.value || { error: lever.reason?.message },
    ashby: ashby.value || { error: ashby.reason?.message },
    workable: workable.value || { error: workable.reason?.message },
    smartrecruiters: sr.value || { error: sr.reason?.message },
    recruitee: recruitee.value || { error: recruitee.reason?.message },
    manual: manual.value || { error: manual.reason?.message },
    greenhouse: greenhouse.value || { error: greenhouse.reason?.message },
    personio: personio.value || { error: personio.reason?.message },
  };
}

async function crawlOne(platform, slug) {
  const { crawlGreenhouseBoard } = require("./greenhouse");
  const { crawlLeverCompany } = require("./lever");
  const { crawlAshbyCompany } = require("./ashby");
  const { crawlWorkableCompany } = require("./workable");
  const { crawlSmartRecruitersCompany } = require("./smartrecruiters");
  const { crawlRecruiteeCompany } = require("./recruitee");
  const { crawlPersonioCompany } = require("./personio");
  const { upsertJobs } = require("../services/db");

  let jobs = [];
  if (platform === "greenhouse") jobs = await crawlGreenhouseBoard(slug);
  else if (platform === "lever") jobs = await crawlLeverCompany(slug);
  else if (platform === "ashby") jobs = await crawlAshbyCompany(slug);
  else if (platform === "workable") jobs = await crawlWorkableCompany(slug);
  else if (platform === "smartrecruiters") jobs = await crawlSmartRecruitersCompany(slug);
  else if (platform === "recruitee") jobs = await crawlRecruiteeCompany(slug);
  else if (platform === "personio") jobs = await crawlPersonioCompany(slug);
  else throw new Error(`Unknown platform: ${platform}`);

  if (jobs.length) await upsertJobs(jobs);
  return { platform, slug, count: jobs.length };
}

module.exports = { runFullCrawl, runQuickCrawl, crawlOne };
