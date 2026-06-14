const axios = require("axios");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// WORKABLE CRAWLER
// Workable hosts job boards for thousands of companies — and skews
// toward SMBs, non-tech, and international (incl. Africa/Europe)
// employers, which broadens Goojob beyond the tech-heavy
// Greenhouse/Lever/Ashby sets.
//
// Each company has a public JSON API:
//   https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
// And public job pages at:
//   https://apply.workable.com/{slug}/j/{shortcode}/
// These are DIRECT company application pages — no middleman.
// ─────────────────────────────────────────────────────────────

const CONCURRENCY = 6;
const DELAY_MS = 350;

// Seed list of known Workable companies across sectors.
// Crawler skips any that 404 or return empty.
const WORKABLE_COMPANIES = [
  // tech
  "workable", "persado", "blueground", "e-food", "skroutz",
  "beat", "instashop", "viva-wallet", "softomotive",
  // media / content / agencies
  "publicis", "ogilvy", "wpp", "dentsu", "havas",
  // retail / consumer / hospitality
  "pepco", "folli-follie", "mytheresa", "notino", "glovo",
  "wolt", "deliveroo", "gorillas", "flink", "getir",
  // finance / services
  "viva", "plum", "revolut", "qonto", "spendesk",
  // health
  "babylon", "kry", "doctolib", "alan", "wefox",
  // africa / emerging markets
  "andela", "flutterwave", "paystack", "jumia", "kobo360",
  "twiga", "sokowatch", "mpharma", "lori-systems", "yoco",
  "sendy", "copia", "wasoko", "trella", "max-ng",
  // europe / intl SMB tech
  "pipedrive", "bolt", "vinted", "wise", "monzo",
  "gocardless", "tide", "starling", "thought-machine",
];

/**
 * Crawl a single Workable company via their public widget API
 */
async function crawlWorkableCompany(slug) {
  const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
  try {
    const { data } = await axios.get(apiUrl, {
      timeout: 8000,
      headers: { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" },
    });

    if (!data || !Array.isArray(data.jobs)) return [];

    const companyName = data.name || slug;

    const jobs = data.jobs.map((j) => {
      // Direct link to the specific job application page
      const applyUrl = j.url || `https://apply.workable.com/${slug}/j/${j.shortcode}/`;
      return {
        external_id: `workable_${slug}_${j.shortcode}`,
        title: j.title || "",
        company: companyName,
        location: [j.city, j.state, j.country].filter(Boolean).join(", ") || "",
        remote: !!j.remote || /remote/i.test(j.title || ""),
        type: j.employment_type || "",
        description: j.description || "",
        apply_url: applyUrl,
        source: "workable",
        posted_at: j.published_on || j.created_at || new Date().toISOString(),
      };
    }).filter((j) => j.title && j.apply_url);

    return jobs;
  } catch (err) {
    // 404 / empty / network — skip silently
    return [];
  }
}

async function runWorkableCrawler({ slugs = WORKABLE_COMPANIES, onProgress } = {}) {
  let totalJobs = 0;
  let companiesProcessed = 0;

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((s) => crawlWorkableCompany(s)));

    for (const jobs of results) {
      if (jobs.length) {
        await upsertJobs(jobs).catch((e) => console.error("[WORKABLE upsert]", e.message));
        totalJobs += jobs.length;
      }
    }
    companiesProcessed += batch.length;
    if (onProgress) onProgress({ source: "workable", companiesProcessed, totalJobs });
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`[WORKABLE] Done — ${totalJobs} jobs from ${companiesProcessed} companies`);
  return { totalJobs, companiesProcessed };
}

module.exports = { runWorkableCrawler, crawlWorkableCompany, WORKABLE_COMPANIES };
