const cheerio = require("cheerio");
const { getOk } = require("../services/http-client");
const { loadBoards } = require("../services/boards");
const { saveBoardJobs } = require("./lib/save-board");

// ─────────────────────────────────────────────────────────────
// GREENHOUSE CRAWLER (expanded + JSON API based)
//
// Greenhouse hosts boards for thousands of companies. We hit the public
// JSON API. The old sitemap URL now 301s to a 404, so the scheduled crawl
// uses the verified slug list in data/boards.json plus PRIORITY_BOARDS.
//   1. Optional sitemap, when it actually returns board URLs.
//   2. For each slug, the public JSON API:
//        https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
//      This returns clean structured jobs with direct absolute_url
//      links to the SPECIFIC role page — no HTML scraping, no breakage.
//
// Every link is the company's own Greenhouse posting = always direct.
// ─────────────────────────────────────────────────────────────

const GREENHOUSE_SITEMAP = "https://boards.greenhouse.io/sitemap.xml";
const CONCURRENCY = 4;
const DELAY_MS = 200;

// Boards confirmed to return public jobs on 16 Nov 2026. Healthcare and
// education are included on purpose — the 6-hour quick crawl used to skip
// Greenhouse entirely, so nurse and teacher roles never landed in the index
// even when the board was public. The daily sitemap crawl still tries to
// cover every Greenhouse company; this list is the part that actually runs
// on a schedule short enough to matter.
const PRIORITY_BOARDS = [
  // healthcare (One Medical and Clover Health were posting nurse roles)
  "onemedical", "cloverhealth", "betterhelp", "honor", "papa",
  "freenome", "flatironhealth", "natera", "veracyte", "forward",
  "oscar", "ginkgobioworks",
  // education / learning
  "khanacademy", "coursera", "duolingo", "udemy", "datacamp",
  "swingeducation", "2u", "calm", "peloton",
];

function verifiedGreenhouseSlugs() {
  const extra = loadBoards().greenhouse || [];
  return [...new Set([...PRIORITY_BOARDS, ...extra])];
}

// The public sitemap used to list every board. As of 17 Nov 2026
// https://boards.greenhouse.io/sitemap.xml 301s to a 404, so a crawl that
// trusted it saved nothing. Keep the attempt, and fall back to the verified list.
async function getGreenhouseCompanySlugs() {
  console.log("[GREENHOUSE] Fetching sitemap...");
  try {
    const { status, data } = await getOk(GREENHOUSE_SITEMAP, {
      timeout: 20000,
      headers: { Accept: "application/xml, text/xml, */*" },
    });
    const xml = typeof data === "string" ? data : "";
    if (status === 404 || !xml.includes("<loc")) {
      console.error("[GREENHOUSE] sitemap is not available; using the verified board list");
      return [];
    }
    const $ = cheerio.load(xml, { xmlMode: true });
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
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const { status, data } = await getOk(apiUrl, { timeout: 15000 });
  if (status === 404 || !data || !Array.isArray(data.jobs)) {
    return { ok: status === 404, missing: status === 404, jobs: [] };
  }
  const jobs = data.jobs.map((j) => {
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
      apply_url: j.absolute_url,
      source: "greenhouse",
      posted_at: j.updated_at || j.first_published || null,
      date_quality: j.updated_at || j.first_published ? "exact" : "unknown",
    };
  }).filter((j) => j.title && j.apply_url);
  return { ok: true, jobs };
}

async function runGreenhouseCrawler({ limit = 100000, slugs = null, onProgress } = {}) {
  let list = slugs;
  if (!list) {
    const fromSitemap = await getGreenhouseCompanySlugs();
    list = fromSitemap.length ? fromSitemap.slice(0, limit) : verifiedGreenhouseSlugs();
  }
  let totalJobs = 0;
  let processed = 0;
  const errors = [];

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (slug) => {
      try {
        if (!/^[a-z0-9_-]+$/i.test(slug)) return { slug, jobs: [] };
        const result = await crawlGreenhouseBoard(slug);
        if (!result.ok) return { slug, jobs: [], skipped: true };
        if (result.jobs.length || result.ok) {
          await saveBoardJobs({
            prefix: `greenhouse_${slug}_`,
            jobs: result.jobs,
            complete: result.ok && !result.missing,
          });
        }
        return { slug, jobs: result.jobs };
      } catch (err) {
        errors.push({ slug, error: err.message });
        console.error(`[GREENHOUSE] ${slug}: ${err.message}`);
        return { slug, jobs: [], error: err.message };
      }
    }));

    for (const result of results) totalJobs += result.jobs.length;
    processed += batch.length;
    if (onProgress && processed % 50 === 0) {
      onProgress({ source: "greenhouse", processed, totalJobs });
      console.log(`[GREENHOUSE] ${processed}/${list.length} companies, ${totalJobs} jobs`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`[GREENHOUSE] Done — ${totalJobs} jobs from ${processed} companies`);
  return { totalJobs, companiesProcessed: processed, errors };
}

module.exports = {
  runGreenhouseCrawler,
  crawlGreenhouseBoard,
  getGreenhouseCompanySlugs,
  verifiedGreenhouseSlugs,
  PRIORITY_BOARDS,
};
