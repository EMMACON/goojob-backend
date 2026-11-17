const { getOk, RobotsError } = require("../services/http-client");
const { loadBoards } = require("../services/boards");
const { saveBoardJobs } = require("./lib/save-board");

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseSitemapXml(xml) {
  const entries = [];
  const blocks = String(xml || "").split(/<url\b/i).slice(1);
  for (const block of blocks) {
    const locMatch = block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i);
    if (!locMatch) continue;
    const modMatch = block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i);
    entries.push({
      loc: decodeXml(locMatch[1]),
      lastmod: modMatch ? decodeXml(modMatch[1]) : null,
    });
  }
  return entries;
}

function humanizeSlug(slug) {
  return String(slug || "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}

function parseAccorJob(entry) {
  let url;
  try {
    url = new URL(entry.loc);
  } catch {
    return null;
  }
  const match = url.pathname.match(/\/job\/(.+)-jid-(\d+)\/?$/i);
  if (!match) return null;
  const id = match[2];
  const slug = match[1];
  const splitAt = slug.lastIndexOf("-in-");
  const titleSlug = splitAt > 0 ? slug.slice(0, splitAt) : slug;
  const locationSlug = splitAt > 0 ? slug.slice(splitAt + 4) : "";
  const posted = entry.lastmod ? new Date(entry.lastmod) : null;
  return {
    external_id: `sitemap_accor_${id}`,
    title: humanizeSlug(titleSlug),
    company: "Accor",
    location: humanizeSlug(locationSlug),
    remote: /remote/i.test(locationSlug),
    type: "",
    description: "",
    apply_url: entry.loc,
    source: "sitemap",
    posted_at: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
    date_quality: posted && !Number.isNaN(posted.getTime()) ? "exact" : "unknown",
  };
}

const PARSERS = {
  accor: parseAccorJob,
};

async function fetchSitemapFeed(feed) {
  const { status, data } = await getOk(feed.sitemap, {
    timeout: 30000,
    headers: { Accept: "application/xml, text/xml, */*" },
  });
  if (status === 404 || !data) return { jobs: [], ok: false, projectedTotal: 0 };
  const xml = typeof data === "string" ? data : "";
  const parser = PARSERS[feed.parser];
  if (!parser) throw new Error(`Unknown sitemap parser ${feed.parser}`);
  const jobs = [];
  const seen = new Set();
  for (const entry of parseSitemapXml(xml)) {
    const job = parser(entry);
    if (!job || seen.has(job.external_id)) continue;
    seen.add(job.external_id);
    jobs.push(job);
  }
  return { jobs, ok: true, projectedTotal: jobs.length, company: feed.company };
}

async function runSitemapCrawler({ feeds = null, onProgress } = {}) {
  const list = feeds || loadBoards().sitemaps;
  let totalJobs = 0;
  const errors = [];
  for (const feed of list) {
    try {
      const result = await fetchSitemapFeed(feed);
      if (result.ok) {
        await saveBoardJobs({
          prefix: `sitemap_${feed.key}_`,
          jobs: result.jobs,
          complete: true,
        });
        totalJobs += result.jobs.length;
      }
      if (onProgress) onProgress({ source: "sitemap", company: feed.company, totalJobs });
      console.log(`[SITEMAP] ${feed.company}: ${result.jobs.length} jobs`);
    } catch (err) {
      if (err instanceof RobotsError || err.code === "ROBOTS") {
        console.error(`[SITEMAP] ${feed.company} skipped: ${err.message}`);
      } else {
        console.error(`[SITEMAP] ${feed.company}: ${err.message}`);
      }
      errors.push({ company: feed.company, error: err.message });
    }
  }
  return { totalJobs, feeds: list.length, errors };
}

module.exports = {
  parseSitemapXml,
  parseAccorJob,
  humanizeSlug,
  fetchSitemapFeed,
  runSitemapCrawler,
};
