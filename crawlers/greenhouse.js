const axios = require("axios");
const cheerio = require("cheerio");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// GREENHOUSE DIRECTORY CRAWLER
// Greenhouse hosts job boards for 5,000+ companies.
// Each job URL opens the SPECIFIC role page (like Image 2 you
// shared) — with title, location, team, and an Apply button.
// Not the careers listing page (Image 1) — the exact job post.
// ─────────────────────────────────────────────────────────────

const GREENHOUSE_SITEMAP = "https://boards.greenhouse.io/sitemap.xml";
const CONCURRENCY = 5;
const DELAY_MS = 500;
const MAX_COMPANIES = 500;

/**
 * Step 1 — Get all company slugs from Greenhouse sitemap
 */
async function getGreenhouseCompanySlugs() {
  console.log("[GREENHOUSE] Fetching sitemap...");
  const { data } = await axios.get(GREENHOUSE_SITEMAP, { timeout: 15000 });
  const $ = cheerio.load(data, { xmlMode: true });

  const slugs = [];
  $("loc").each((_, el) => {
    const url = $(el).text().trim();
    const match = url.match(/boards\.greenhouse\.io\/([^/\s]+)$/);
    if (match && match[1] !== "sitemap") {
      slugs.push(match[1]);
    }
  });

  console.log(`[GREENHOUSE] Found ${slugs.length} companies in sitemap`);
  return slugs;
}

/**
 * Step 2 — Crawl a single Greenhouse board
 * Each job URL points to the SPECIFIC job post page —
 * the one with the role title, details, and Apply button.
 * NOT the company's main careers/jobs listing page.
 */
async function crawlGreenhouseBoard(slug) {
  const url = `https://boards.greenhouse.io/${slug}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" },
    });
    const $ = cheerio.load(data);
    const jobs = [];

    $(".opening").each((_, el) => {
      const titleEl = $(el).find("a");
      const title = titleEl.text().trim();
      const href = titleEl.attr("href") || "";
      const location = $(el).find(".location").text().trim();

      if (!title || !href) return;

      // Extract the numeric job ID from the URL
      // e.g. /stripe/jobs/6094845 → 6094845
      const jobIdMatch = href.match(/\/jobs\/(\d+)/);
      const jobId = jobIdMatch ? jobIdMatch[1] : null;

      // Build the specific job page URL.
      // If the href already points to the company's own domain
      // (e.g. stripe.com/jobs/listing/.../6094845), use that —
      // it opens their branded role page identical to your screenshot.
      // Otherwise use the Greenhouse-hosted specific job page —
      // also opens the exact role, not the listing page.
      let applyUrl;
      if (href.startsWith("http") && !href.includes("boards.greenhouse.io")) {
        applyUrl = href; // company's own branded job page
      } else if (jobId) {
        applyUrl = `https://boards.greenhouse.io/${slug}/jobs/${jobId}`;
      } else {
        applyUrl = href.startsWith("http") ? href : `https://boards.greenhouse.io${href}`;
      }

      jobs.push({
        external_id: `gh_${slug}_${jobId || slugify(title)}`,
        title,
        company: formatCompanyName(slug),
        location: location || "Unknown",
        remote: isRemote(location),
        type: "Full-time",
        description: "",
        apply_url: applyUrl,
        company_logo: null,
        logo_color: hashColor(slug),
        posted_at: new Date().toISOString(),
        source: "greenhouse",
        featured: false,
      });
    });

    return jobs;
  } catch (err) {
    return [];
  }
}

/**
 * Main runner — crawl all Greenhouse companies in batches
 */
async function runGreenhouseCrawler({ limit = MAX_COMPANIES, onProgress } = {}) {
  const slugs = await getGreenhouseCompanySlugs();
  const toProcess = slugs.slice(0, limit);

  let totalJobs = 0;
  let companiesProcessed = 0;
  const errors = [];

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map((slug) => crawlGreenhouseBoard(slug))
    );

    const allJobs = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.length > 0) {
        allJobs.push(...result.value);
        totalJobs += result.value.length;
      }
    }

    if (allJobs.length > 0) {
      await upsertJobs(allJobs).catch((e) =>
        errors.push(`DB upsert error: ${e.message}`)
      );
    }

    companiesProcessed += batch.length;

    if (onProgress) {
      onProgress({ companiesProcessed, total: toProcess.length, totalJobs });
    }

    console.log(
      `[GREENHOUSE] ${companiesProcessed}/${toProcess.length} companies | ${totalJobs} jobs saved`
    );

    await sleep(DELAY_MS);
  }

  return { companiesProcessed, totalJobs, errors };
}

// ─── Helpers ─────────────────────────────────────────────────

function formatCompanyName(slug) {
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function isRemote(location = "") {
  return /remote|anywhere|worldwide/i.test(location);
}

function slugify(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashColor(str) {
  const colors = [
    "#6366F1", "#8B5CF6", "#EC4899", "#F59E0B",
    "#10B981", "#3B82F6", "#EF4444", "#14B8A6",
    "#F97316", "#84CC16", "#06B6D4", "#A855F7",
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % colors.length;
  }
  return colors[Math.abs(hash)];
}

module.exports = { runGreenhouseCrawler, crawlGreenhouseBoard };
