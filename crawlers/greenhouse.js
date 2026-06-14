const axios = require("axios");
const cheerio = require("cheerio");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// GREENHOUSE CRAWLER (expanded + JSON API based)
//
// Greenhouse hosts boards for THOUSANDS of companies. We:
//   1. Pull every company slug from the public sitemap.
//   2. For each, hit the public JSON API:
//        https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
//      This returns clean structured jobs with direct absolute_url
//      links to the SPECIFIC role page — no HTML scraping, no breakage.
//
// Every link is the company's own Greenhouse posting = always direct.
// ─────────────────────────────────────────────────────────────

const GREENHOUSE_SITEMAP = "https://boards.greenhouse.io/sitemap.xml";
const CONCURRENCY = 8;          // parallel company fetches
const DELAY_MS = 250;
const UA = { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" };

// Pull all company slugs from the sitemap
async function getGreenhouseCompanySlugs() {
  console.log("[GREENHOUSE] Fetching sitemap...");
  try {
    const { data } = await axios.get(GREENHOUSE_SITEMAP, { timeout: 20000, headers: UA });
    const $ = cheerio.load(data, { xmlMode: true });
    const slugs = [];
    $("loc").each((_, el) => {
      const url = $(el).text().trim();
      const match = url.match(/boards\.greenhouse\.io\/([^/\s]+)$/);
      if (match && match[1] !== "sitemap") slugs.push(match[1]);
    });
    console.log(`[GREENHOUSE] Found ${slugs.length} companies in sitemap`);
    return [...new Set(slugs)];
  } catch (e) {
    console.error("[GREENHOUSE] sitemap error:", e.message);
    return [];
  }
}

// Crawl one company via the JSON API (clean + direct links)
async function crawlGreenhouseBoard(slug) {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  try {
    const { data } = await axios.get(apiUrl, { timeout: 9000, headers: UA });
    if (!data || !Array.isArray(data.jobs)) return [];

    return data.jobs.map((j) => {
      const loc = j.location?.name || "";
      const remote = /remote|anywhere|work from home|distributed/i.test(`${j.title} ${loc}`);
      return {
        external_id: `greenhouse_${slug}_${j.id}`,
        title: j.title || "",
        company: (j.company_name || slug).replace(/-/g, " "),
        location: loc,
        remote,
        type: "",
        description: (j.content || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").slice(0, 600),
        apply_url: j.absolute_url,   // DIRECT to the specific role
        source: "greenhouse",
        posted_at: j.updated_at || new Date().toISOString(),
      };
    }).filter((j) => j.title && j.apply_url);
  } catch (err) {
    // 404 / empty board / rate-limited — skip silently
    return [];
  }
}

async function runGreenhouseCrawler({ limit = 100000, onProgress } = {}) {
  const slugs = (await getGreenhouseCompanySlugs()).slice(0, limit);
  let totalJobs = 0;
  let processed = 0;

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((s) => crawlGreenhouseBoard(s)));

    for (const jobs of results) {
      if (jobs.length) {
        await upsertJobs(jobs).catch((e) => console.error("[GH upsert]", e.message));
        totalJobs += jobs.length;
      }
    }
    processed += batch.length;
    if (onProgress && processed % 200 === 0) {
      onProgress({ source: "greenhouse", processed, totalJobs });
      console.log(`[GREENHOUSE] ${processed}/${slugs.length} companies, ${totalJobs} jobs`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`[GREENHOUSE] Done — ${totalJobs} jobs from ${processed} companies`);
  return { totalJobs, companiesProcessed: processed };
}

module.exports = { runGreenhouseCrawler, crawlGreenhouseBoard, getGreenhouseCompanySlugs };
