const axios = require("axios");
const cheerio = require("cheerio");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// PERSONIO CRAWLER
//
// Personio is common among European employers outside the US-tech
// Greenhouse/Lever set (insurance, retail, HR, banking). Each company
// publishes an unauthenticated XML feed:
//   https://{slug}.jobs.personio.de/xml
// and a human job page:
//   https://{slug}.jobs.personio.de/job/{id}
// That page is the company's own posting, not a job board.
//
// Slugs below were checked on 16 Nov 2026. Unknown slugs 404 and are
// skipped, so adding a name here is safe.
// ─────────────────────────────────────────────────────────────

const CONCURRENCY = 4;
const DELAY_MS = 300;
const UA = { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" };

const PERSONIO_COMPANIES = [
  "personio",
  "clark",
  "circula",
  "penta",
  "westwing",
  "vivid",
];

async function fetchFeed(slug) {
  const urls = [
    `https://${slug}.jobs.personio.de/xml`,
    `https://${slug}.jobs.personio.com/xml`,
  ];
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { timeout: 12000, headers: UA });
      const xml = String(data || "");
      if (xml.includes("<position")) return { xml, origin: new URL(url).origin };
    } catch {
      // try the other host
    }
  }
  return null;
}

function childText($, el, name) {
  const node = $(el).children(name).first();
  return node.text().trim();
}

async function crawlPersonioCompany(slug) {
  const feed = await fetchFeed(slug);
  if (!feed) return [];

  const $ = cheerio.load(feed.xml, { xmlMode: true });
  const jobs = [];

  $("position").each((_, el) => {
    const id = childText($, el, "id");
    const title = childText($, el, "name");
    if (!id || !title) return;

    const offices = [];
    $(el).children("office").each((__, office) => {
      const value = $(office).text().trim();
      if (value) offices.push(value);
    });

    const descriptions = [];
    $(el).find("jobDescription").each((__, block) => {
      const html = $(block).find("value").html() || $(block).find("value").text();
      if (html) descriptions.push(html);
    });

    const type = [childText($, el, "employmentType"), childText($, el, "schedule")]
      .filter(Boolean)
      .join(" ");
    const created = new Date(childText($, el, "createdAt"));

    jobs.push({
      external_id: `personio_${slug}_${id}`,
      title,
      company: childText($, el, "subcompany") || slug,
      location: offices.join(", "),
      remote: offices.some((office) => /remote|home/i.test(office)),
      type,
      description: descriptions.join(" "),
      apply_url: `${feed.origin}/job/${id}`,
      source: "personio",
      posted_at: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
      featured: false,
    });
  });

  return jobs.filter((job) => job.title && job.apply_url);
}

async function runPersonioCrawler({ slugs = PERSONIO_COMPANIES, onProgress } = {}) {
  let totalJobs = 0;
  let companiesProcessed = 0;

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((slug) => crawlPersonioCompany(slug)));
    for (const jobs of results) {
      if (jobs.length) {
        await upsertJobs(jobs).catch((e) => console.error("[PERSONIO upsert]", e.message));
        totalJobs += jobs.length;
      }
    }
    companiesProcessed += batch.length;
    if (onProgress) onProgress({ source: "personio", companiesProcessed, totalJobs });
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`[PERSONIO] Done — ${totalJobs} jobs from ${companiesProcessed} companies`);
  return { totalJobs, companiesProcessed };
}

module.exports = { runPersonioCrawler, crawlPersonioCompany, PERSONIO_COMPANIES };
