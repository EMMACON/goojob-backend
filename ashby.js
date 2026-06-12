const axios = require("axios");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// ASHBY DIRECTORY CRAWLER
// Ashby is a newer ATS platform growing fast among startups.
// Their job boards are at: https://jobs.ashbyhq.com/{slug}
// They also expose a public API per company:
//   POST https://api.ashbyhq.com/posting-api/job-board/{slug}
// Returns structured JSON with direct apply links.
// ─────────────────────────────────────────────────────────────

const CONCURRENCY = 6;
const DELAY_MS = 400;

const ASHBY_COMPANIES = [
  "anthropic", "openai", "mistral", "cohere", "adept",
  "inflection", "characterai", "perplexity", "eleven-labs",
  "runway", "stability-ai", "midjourney", "leonardo-ai",
  "linear", "retool", "airplane", "windmill", "pipedream",
  "nango", "merge", "finch", "alloy", "vessel",
  "drata", "vanta", "secureframe", "laika", "tugboat-logic",
  "watershed", "patch", "terrapass", "pachama", "single-use-ain",
  "brex", "mercury", "ramp", "pilot", "bench",
  "rippling", "deel", "remote", "oyster", "papaya-global",
  "lattice", "leapsome", "15five", "betterworks", "small-improvements",
  "coda", "notion", "craft", "nuclino", "tettra",
  "posthog", "june", "amplitude", "mixpanel", "heap",
  "segment", "rudderstack", "mparticle", "tealium", "lytics",
  "hightouch", "census", "polytomic", "grouparoo", "airbyte",
  "fivetran", "stitch", "matillion", "wherescape", "streamsets",
  "dbt-labs", "lightdash", "metabase", "mode", "sigma",
  "hex", "deepnote", "jupyter", "colab", "gradient",
  "modal", "beam", "banana", "replicate", "baseten",
  "scale-ai", "snorkel-ai", "aquarium", "encord", "v7",
  "robust-intelligence", "arthur", "fiddler", "evidently", "whylabs",
  "celonis", "signavio", "nintex", "pipefy", "appian",
  "ashby", "greenhouse", "lever", "workable", "teamtailor",
  "factorial", "personio", "bob", "kenjo", "humaans",
  "pave", "levels", "comprehensive", "assemble", "pequity",
  "carta", "pulley", "secfi", "quid", "caplight",
  "anduril", "shield-ai", "joby", "archer", "lilium",
  "boom", "hermeus", "exosonic", "spike-aerospace",
  "relativity-space", "astranis", "planet", "spire", "muon-space",
];

/**
 * Crawl a single Ashby company via their public posting API
 */
async function crawlAshbyCompany(slug) {
  try {
    const { data } = await axios.post(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      { includeCompensation: false },
      {
        timeout: 8000,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)",
        },
      }
    );

    const jobs = data?.jobs || [];
    if (!jobs.length) return [];

    return jobs.map((job) => ({
      external_id: `ashby_${job.id}`,
      title: job.title || "Unknown Role",
      company: data.organization?.name || formatCompanyName(slug),
      location: extractAshbyLocation(job),
      remote: isAshbyRemote(job),
      type: normalizeType(job.employmentType),
      description: job.descriptionSafe?.slice(0, 500) || "",
      // Direct link to their Ashby-hosted job page
      apply_url: `https://jobs.ashbyhq.com/${slug}/${job.id}`,
      company_logo: data.organization?.logoUrl || null,
      logo_color: hashColor(slug),
      posted_at: job.publishedAt || new Date().toISOString(),
      source: "ashby",
      featured: false,
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Main runner
 */
async function runAshbyCrawler({ slugs = ASHBY_COMPANIES, onProgress } = {}) {
  let totalJobs = 0;
  let companiesProcessed = 0;
  const errors = [];

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map((slug) => crawlAshbyCompany(slug))
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
        errors.push(`DB: ${e.message}`)
      );
    }

    companiesProcessed += batch.length;
    if (onProgress) onProgress({ companiesProcessed, total: slugs.length, totalJobs });

    console.log(`[ASHBY] ${companiesProcessed}/${slugs.length} companies | ${totalJobs} jobs`);
    await sleep(DELAY_MS);
  }

  return { companiesProcessed, totalJobs, errors };
}

// ─── Helpers ─────────────────────────────────────────────────

function extractAshbyLocation(job) {
  if (!job.isRemote && !job.locationIds?.length) return "Unknown";
  if (job.isRemote) return "Remote";
  return job.location || "Unknown";
}

function isAshbyRemote(job) {
  return job.isRemote === true || /remote|anywhere/i.test(job.location || "");
}

function normalizeType(type = "") {
  if (/part/i.test(type)) return "Part-time";
  if (/contract/i.test(type)) return "Contract";
  if (/intern/i.test(type)) return "Internship";
  return "Full-time";
}

function formatCompanyName(slug) {
  return slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashColor(str) {
  const colors = ["#6366F1","#8B5CF6","#EC4899","#F59E0B","#10B981","#3B82F6","#EF4444","#14B8A6","#F97316","#84CC16"];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % colors.length;
  return colors[Math.abs(hash)];
}

module.exports = { runAshbyCrawler, crawlAshbyCompany, ASHBY_COMPANIES };
