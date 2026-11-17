const { runGreenhouseCrawler, verifiedGreenhouseSlugs } = require("./greenhouse");
const { runLeverCrawler, discoverNewLeverCompanies } = require("./lever");
const { runAshbyCrawler } = require("./ashby");
const { runWorkableCrawler } = require("./workable");
const { runSmartRecruitersCrawler } = require("./smartrecruiters");
const { runRecruiteeCrawler } = require("./recruitee");
const { runManualSheetCrawler } = require("./manual-sheet");
const { runPersonioCrawler } = require("./personio");
const { runWorkdayCrawler } = require("./workday");
const { runOracleCrawler } = require("./oracle-cloud");
const { runBambooHrCrawler } = require("./bamboohr");
const { runSitemapCrawler } = require("./sitemap-feed");
const { expireOlderThan } = require("../services/expiry");

const crawlState = {
  running: null,
  startedAt: null,
  lastQuickAt: null,
  lastFullAt: null,
  lastResult: null,
  lastError: null,
  bootAt: null,
};

let inFlight = null;

function getCrawlState() {
  return {
    running: crawlState.running,
    startedAt: crawlState.startedAt,
    lastQuickAt: crawlState.lastQuickAt,
    lastFullAt: crawlState.lastFullAt,
    lastError: crawlState.lastError,
    bootAt: crawlState.bootAt,
    lastResult: crawlState.lastResult,
  };
}

async function runAll({ depth }) {
  console.log(`[CRAWL] ${depth} crawl starting`);
  const startTime = Date.now();
  const summary = {};

  summary.manual = await runManualSheetCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.sitemap = await runSitemapCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.workday = await runWorkdayCrawler({ depth }).catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.oracle = await runOracleCrawler({ depth }).catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.bamboohr = await runBambooHrCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.personio = await runPersonioCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.ashby = await runAshbyCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.lever = await runLeverCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.workable = await runWorkableCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.smartrecruiters = await runSmartRecruitersCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.recruitee = await runRecruiteeCrawler().catch((e) => ({ error: e.message, totalJobs: 0 }));
  summary.greenhouse = await runGreenhouseCrawler({ slugs: verifiedGreenhouseSlugs() }).catch((e) => ({ error: e.message, totalJobs: 0 }));

  if (depth === "full") {
    summary.expired = await expireOlderThan().catch((e) => ({ error: e.message }));
  }

  const totalJobs = Object.values(summary).reduce((sum, row) => sum + (row && row.totalJobs ? row.totalJobs : 0), 0);
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  console.log(`[CRAWL] ${depth} done in ${durationSeconds}s | fetched ${totalJobs} jobs`);
  return { summary, totalJobs, durationSeconds, depth };
}

function startCrawl(depth) {
  if (inFlight) {
    console.log(`[CRAWL] ${depth} skipped; a crawl is already running`);
    return inFlight;
  }
  crawlState.running = depth;
  crawlState.startedAt = new Date().toISOString();
  inFlight = runAll({ depth })
    .then((result) => {
      crawlState.lastResult = {
        depth,
        totalJobs: result.totalJobs,
        durationSeconds: result.durationSeconds,
        counts: Object.fromEntries(Object.entries(result.summary).map(([key, value]) => [key, {
          totalJobs: value && value.totalJobs,
          projected: value && value.projected,
          skipped: value && value.skipped,
          error: value && value.error,
        }])),
      };
      crawlState.lastError = null;
      if (depth === "full") crawlState.lastFullAt = new Date().toISOString();
      else crawlState.lastQuickAt = new Date().toISOString();
      return result;
    })
    .catch((err) => {
      crawlState.lastError = err.message;
      throw err;
    })
    .finally(() => {
      crawlState.running = null;
      inFlight = null;
    });
  return inFlight;
}

async function runFullCrawl() {
  return startCrawl("full");
}

async function runQuickCrawl() {
  return startCrawl("quick");
}

function noteBootCrawl() {
  crawlState.bootAt = new Date().toISOString();
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
  const { loadBoards } = require("../services/boards");

  let jobs = [];
  if (platform === "greenhouse") jobs = (await crawlGreenhouseBoard(slug)).jobs || [];
  else if (platform === "lever") jobs = await crawlLeverCompany(slug);
  else if (platform === "ashby") jobs = await crawlAshbyCompany(slug);
  else if (platform === "workable") jobs = await crawlWorkableCompany(slug);
  else if (platform === "smartrecruiters") {
    const verdict = await require("../services/robots").robotsFor(`https://api.smartrecruiters.com/v1/companies/${slug}/postings`);
    if (!verdict.allowed) throw new Error("robots.txt disallows the SmartRecruiters API");
    jobs = await crawlSmartRecruitersCompany(slug);
  } else if (platform === "recruitee") jobs = await crawlRecruiteeCompany(slug);
  else if (platform === "personio") jobs = await crawlPersonioCompany(slug);
  else if (platform === "workday") {
    const board = loadBoards().workday.find((item) => item.tenant === slug || item.company.toLowerCase() === String(slug).toLowerCase());
    if (!board) throw new Error(`No verified Workday board for ${slug}`);
    const result = await require("./workday").fetchWorkdayBoard(board, { depth: "quick" });
    jobs = result.jobs;
  } else if (platform === "oracle") {
    const board = loadBoards().oracle.find((item) => item.key === slug);
    if (!board) throw new Error(`No verified Oracle board for ${slug}`);
    const result = await require("./oracle-cloud").fetchOracleBoard(board, { depth: "quick" });
    jobs = result.jobs;
  } else if (platform === "bamboohr") {
    const result = await require("./bamboohr").fetchBambooCompany(slug);
    jobs = result.jobs;
  } else if (platform === "sitemap") {
    const feed = loadBoards().sitemaps.find((item) => item.key === slug);
    if (!feed) throw new Error(`No sitemap feed for ${slug}`);
    const result = await require("./sitemap-feed").fetchSitemapFeed(feed);
    jobs = result.jobs;
  } else throw new Error(`Unknown platform: ${platform}`);

  if (jobs.length) await upsertJobs(jobs);
  return { platform, slug, count: jobs.length };
}

module.exports = {
  runFullCrawl,
  runQuickCrawl,
  crawlOne,
  getCrawlState,
  noteBootCrawl,
  discoverNewLeverCompanies,
};
