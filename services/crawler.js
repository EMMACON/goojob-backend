const axios = require("axios");
const cheerio = require("cheerio");
const { upsertJobs } = require("./db");

/**
 * Supported company career pages to crawl.
 * These companies use Greenhouse/Lever/Ashby — structured, scrapeable.
 */
const CRAWL_TARGETS = [
  {
    company: "Stripe",
    logo_color: "#635BFF",
    url: "https://boards.greenhouse.io/stripe",
    parser: "greenhouse",
    company_url: "https://stripe.com/jobs",
  },
  {
    company: "Vercel",
    logo_color: "#000000",
    url: "https://vercel.com/careers",
    parser: "lever",
    lever_id: "vercel",
    company_url: "https://vercel.com/careers",
  },
  {
    company: "Linear",
    logo_color: "#5E6AD2",
    url: "https://api.lever.co/v0/postings/linear?mode=json",
    parser: "lever_api",
    company_url: "https://linear.app/careers",
  },
  {
    company: "Supabase",
    logo_color: "#3ECF8E",
    url: "https://boards.greenhouse.io/supabase",
    parser: "greenhouse",
    company_url: "https://supabase.com/careers",
  },
  {
    company: "Notion",
    logo_color: "#000000",
    url: "https://api.lever.co/v0/postings/notion?mode=json",
    parser: "lever_api",
    company_url: "https://www.notion.so/careers",
  },
];

// ─── Parsers ─────────────────────────────────────────────────

/**
 * Parse Greenhouse job board HTML
 */
async function parseGreenhouse(target) {
  const { data } = await axios.get(target.url, { timeout: 10000 });
  const $ = cheerio.load(data);
  const jobs = [];

  $(".opening").each((_, el) => {
    const titleEl = $(el).find("a");
    const title = titleEl.text().trim();
    const href = titleEl.attr("href");
    const location = $(el).find(".location").text().trim();

    if (title && href) {
      jobs.push({
        external_id: `${target.company}_${slugify(title)}_${slugify(location)}`,
        title,
        company: target.company,
        location: location || "Unknown",
        remote: isRemote(location),
        type: "Full-time",
        description: "",
        apply_url: href.startsWith("http") ? href : `https://boards.greenhouse.io${href}`,
        company_logo: null,
        logo_color: target.logo_color,
        posted_at: new Date().toISOString(),
        source: "crawl",
        featured: false,
      });
    }
  });

  return jobs;
}

/**
 * Parse Lever public API (returns JSON directly)
 */
async function parseLeverAPI(target) {
  const { data } = await axios.get(target.url, { timeout: 10000 });
  return data.map((job) => ({
    external_id: job.id,
    title: job.text,
    company: target.company,
    location: job.categories?.location || job.workplaceType || "Unknown",
    remote: isRemote(job.categories?.location || ""),
    type: normalizeCommitment(job.categories?.commitment),
    description: job.descriptionPlain?.slice(0, 500) || "",
    apply_url: job.hostedUrl,             // ← direct Lever-hosted page (no job board)
    company_logo: null,
    logo_color: target.logo_color,
    posted_at: new Date(job.createdAt).toISOString(),
    source: "crawl",
    featured: false,
  }));
}

// ─── Main crawl runner ────────────────────────────────────────

async function crawlTarget(target) {
  try {
    let jobs = [];
    if (target.parser === "greenhouse") jobs = await parseGreenhouse(target);
    else if (target.parser === "lever_api") jobs = await parseLeverAPI(target);

    console.log(`[CRAWL] ${target.company}: found ${jobs.length} jobs`);
    if (jobs.length) await upsertJobs(jobs);
    return { company: target.company, count: jobs.length, status: "ok" };
  } catch (err) {
    console.error(`[CRAWL ERROR] ${target.company}:`, err.message);
    return { company: target.company, count: 0, status: "error", error: err.message };
  }
}

async function runScheduledCrawl() {
  const results = [];
  for (const target of CRAWL_TARGETS) {
    const result = await crawlTarget(target);
    results.push(result);
    // Polite delay between requests
    await sleep(2000);
  }
  console.log("[CRAWL] Done.", results);
  return results;
}

async function crawlSingleCompany(companyName) {
  const target = CRAWL_TARGETS.find(
    (t) => t.company.toLowerCase() === companyName.toLowerCase()
  );
  if (!target) throw new Error(`Company "${companyName}" not in crawl targets`);
  return crawlTarget(target);
}

// ─── Helpers ─────────────────────────────────────────────────

function isRemote(location = "") {
  return /remote|anywhere/i.test(location);
}

function slugify(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

function normalizeCommitment(c = "") {
  if (!c) return "Full-time";
  if (/part/i.test(c)) return "Part-time";
  if (/contract/i.test(c)) return "Contract";
  if (/intern/i.test(c)) return "Internship";
  return "Full-time";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { runScheduledCrawl, crawlSingleCompany, CRAWL_TARGETS };
