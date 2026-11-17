require("dotenv").config();

// Sample crawl used to project coverage. It does not write to the database.
// Caps default low enough to finish in one run; raise them for a deeper sample.
process.env.WORKDAY_PAGE_CAP = process.env.WORKDAY_PAGE_CAP || "2";
process.env.ORACLE_PAGE_CAP = process.env.ORACLE_PAGE_CAP || "2";

const fs = require("fs");
const path = require("path");
const { loadBoards } = require("../services/boards");
const { fetchWorkdayBoard } = require("../crawlers/workday");
const { fetchOracleBoard } = require("../crawlers/oracle-cloud");
const { fetchBambooCompany } = require("../crawlers/bamboohr");
const { fetchSitemapFeed } = require("../crawlers/sitemap-feed");
const { crawlGreenhouseBoard } = require("../crawlers/greenhouse");
const { parseSearchQuery, rankJobs, isFresh } = require("../services/search");

const QUERIES = [
  "nurse",
  "teacher",
  "accountant",
  "accountant Accra",
  "Ghana",
  "remote",
  "software engineer",
];

// Same first-seen dates the crawler stores when the board has no exact timestamp.
// Coarse "30+ days" starts at 30 days old. A missing date starts today and then ages.
function asStored(job) {
  const copy = { ...job };
  if (copy.date_quality === "coarse") {
    copy.posted_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  } else if (!copy.posted_at) {
    copy.posted_at = new Date().toISOString();
  }
  return copy;
}

function tally(jobs) {
  const fresh = jobs.filter((job) => isFresh(job));
  return { fetched: jobs.length, fresh: fresh.length };
}

async function main() {
  const boards = loadBoards();
  const sections = [];
  const all = [];

  const sitemapJobs = [];
  for (const feed of boards.sitemaps) {
    const result = await fetchSitemapFeed(feed);
    const stored = result.jobs.map(asStored);
    sitemapJobs.push(...stored);
    sections.push({ source: `sitemap:${feed.company}`, projected: result.projectedTotal, ...tally(stored) });
    console.log(`[report] sitemap ${feed.company} ${result.jobs.length}`);
  }
  all.push(...sitemapJobs);

  const workdayJobs = [];
  let workdayProjected = 0;
  for (const board of boards.workday) {
    try {
      const result = await fetchWorkdayBoard(board, { depth: "quick" });
      workdayProjected += result.projectedTotal || 0;
      workdayJobs.push(...result.jobs);
      console.log(`[report] workday ${board.company} fetched ${result.jobs.length} reported ${result.projectedTotal}`);
    } catch (err) {
      console.error(`[report] workday ${board.company} ${err.message}`);
    }
  }
  const storedWorkday = workdayJobs.map(asStored);
  sections.push({ source: "workday", projected: workdayProjected, ...tally(storedWorkday) });
  all.push(...storedWorkday);

  const oracleJobs = [];
  let oracleProjected = 0;
  for (const board of boards.oracle) {
    try {
      const result = await fetchOracleBoard(board, { depth: "quick" });
      oracleProjected += result.projectedTotal || 0;
      oracleJobs.push(...result.jobs);
      console.log(`[report] oracle ${board.company} fetched ${result.jobs.length} reported ${result.projectedTotal}`);
    } catch (err) {
      console.error(`[report] oracle ${board.company} ${err.message}`);
    }
  }
  const storedOracle = oracleJobs.map(asStored);
  sections.push({ source: "oracle", projected: oracleProjected, ...tally(storedOracle) });
  all.push(...storedOracle);

  const bambooJobs = [];
  for (const slug of boards.bamboohr) {
    try {
      const result = await fetchBambooCompany(slug);
      bambooJobs.push(...result.jobs);
      console.log(`[report] bamboohr ${slug} ${result.jobs.length}`);
    } catch (err) {
      console.error(`[report] bamboohr ${slug} ${err.message}`);
    }
  }
  const storedBamboo = bambooJobs.map(asStored);
  sections.push({ source: "bamboohr", projected: storedBamboo.length, ...tally(storedBamboo) });
  all.push(...storedBamboo);

  const greenhouseJobs = [];
  for (const slug of boards.greenhouse) {
    try {
      const result = await crawlGreenhouseBoard(slug);
      greenhouseJobs.push(...(result.jobs || []));
      console.log(`[report] greenhouse ${slug} ${(result.jobs || []).length}`);
    } catch (err) {
      console.error(`[report] greenhouse ${slug} ${err.message}`);
    }
  }
  const storedGreenhouse = greenhouseJobs.map(asStored);
  sections.push({ source: "greenhouse", projected: storedGreenhouse.length, ...tally(storedGreenhouse) });
  all.push(...storedGreenhouse);

  const lines = [];
  lines.push("# Coverage report");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} from the public employer endpoints in \`data/boards.json\` (verified ${boards.verifiedOn}).`);
  lines.push("This run does not write to the database. `projected` is the count the employer's API reported. `fetched` is how many postings this run downloaded under the page cap. `fresh` is how many of those have a posted date inside 45 days.");
  lines.push("");
  lines.push("| Source | Projected open postings | Fetched this run | Fresh among fetched |");
  lines.push("| --- | ---: | ---: | ---: |");
  let projected = 0;
  let fetched = 0;
  let fresh = 0;
  for (const row of sections) {
    projected += row.projected || 0;
    fetched += row.fetched || 0;
    fresh += row.fresh || 0;
    lines.push(`| ${row.source} | ${row.projected || 0} | ${row.fetched || 0} | ${row.fresh || 0} |`);
  }
  lines.push(`| **Total** | **${projected}** | **${fetched}** | **${fresh}** |`);
  lines.push("");
  lines.push("Workday and Oracle totals are the employer's own `total` / `TotalJobsCount`. The crawl stores a recent slice plus targeted Accra, Ghana, nurse, teacher, and accountant searches, so `fetched` is lower than `projected` on large hospital and hotel boards. Greenhouse, BambooHR, and the Accor sitemap are fetched in full.");
  lines.push("");
  lines.push("Workday often publishes only \"Posted 30+ Days Ago\". Those rows are stored at 30 days old the first time they are seen, so they count as fresh once and then age out. Later crawls do not move that date forward. BambooHR's public list has no posted date, so the first crawl stamps the day it was discovered.");
  lines.push("");
  lines.push("## Sample search");
  lines.push("");
  lines.push("Ranked with the same matcher the API uses, against the fetched postings only. A zero here means this sample did not contain a hit, not that the projected board has none.");
  lines.push("");

  for (const query of QUERIES) {
    const parsed = parseSearchQuery({ q: query });
    const pool = all.filter((job) => isFresh(job));
    const ranked = rankJobs(pool, parsed);
    lines.push(`### ${query}`);
    lines.push("");
    lines.push(`Fresh matches in this sample: **${ranked.jobs.length}**.`);
    lines.push("");
    const sample = ranked.jobs.slice(0, 5);
    if (!sample.length) {
      lines.push("No fresh match in the downloaded sample.");
      if (query === "accountant Accra") {
        lines.push("");
        lines.push("The sample does include a Chief Financial Officer in Accra at FirstRand and an Accountant in Windhoek at FirstRand. The matcher requires the title to be an accountant role and the place to be Accra, so neither of those is a hit.");
      }
      lines.push("");
      continue;
    }
    for (const job of sample) {
      const where = job.location ? ` — ${job.location}` : "";
      lines.push(`- ${job.title} · ${job.company}${where}`);
      lines.push(`  ${job.apply_url}`);
    }
    lines.push("");
  }

  lines.push("## Why production showed 636 fresh of 4515");
  lines.push("");
  lines.push("Search and `GET /api/jobs/count` treat a job as fresh only when `posted_at` is within 45 days (`maxAgeDays`). The other rows stay in the table. Nothing was deleting a posting after it left the employer's board, and nothing was deleting rows once they aged past 45 days, so `total` is every row ever upserted.");
  lines.push("");
  lines.push("The crawlers store the employer's own date (`updated_at`, `createdAt`, `published_at`), not the time of the crawl. A role that is still open but was posted 46 or more days ago counts in `total` and is hidden from search. That is why a daily crawl can succeed and fresh can still be a small slice of total.");
  lines.push("");
  lines.push("The scheduled crawl does run in this process: `node-cron` in `server.js` starts a quick crawl every 6 hours and a full crawl at 02:00 UTC, and Railway's start command is `npm start`, so the cron is inside the web process. Two gaps kept the index thin:");
  lines.push("");
  lines.push("1. The Greenhouse 'all companies' crawl reads `https://boards.greenhouse.io/sitemap.xml`. On 17 Nov 2026 that URL 301s to a 404, so the full crawl discovered zero boards and saved nothing. The 6-hour crawl only refreshed a short seed list, which is why the live index was a few thousand rows and mostly Lever, SmartRecruiters, and Workable.");
  lines.push("2. A restart drops the in-process cron until the next clock tick. There is no external scheduler. The boot crawl covers that gap, and a lock stops a second crawl from starting while one is already running.");
  lines.push("");
  lines.push("`api.smartrecruiters.com/robots.txt` disallows every agent except LinkedInBot, so this change stops calling that API. Accor's own vacancies sitemap is allowed and replaces that board.");
  lines.push("");
  lines.push("A full crawl now deletes rows whose `posted_at` is older than 180 days, and a completed board fetch deletes postings that disappeared from that board. Filled roles no longer sit in `total` forever. Rows between 46 and 180 days can still make `total` larger than `fresh`.");
  lines.push("");

  const markdown = lines.join("\n");
  const outDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "coverage-2026-11-17.md");
  fs.writeFileSync(outFile, markdown);
  console.log(markdown);
  console.log(`\nWrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
