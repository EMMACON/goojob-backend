const axios = require("axios");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// LEVER DIRECTORY CRAWLER
// Lever hosts job boards for 3,000+ companies.
// Every company on Lever has a public JSON API endpoint:
//   https://api.lever.co/v0/postings/{company_slug}?mode=json
// We maintain a seed list of known Lever companies, then
// use Lever's own posting links (hosted on jobs.lever.co)
// as the direct apply URLs — clean, no middleman.
// ─────────────────────────────────────────────────────────────

const CONCURRENCY = 8;
const DELAY_MS = 300;

/**
 * Known Lever company slugs.
 * This list covers ~200 well-known companies to start.
 * The crawler will skip any that return empty or 404.
 * Add more slugs here as you discover them.
 */
const LEVER_COMPANIES = [
  "netflix", "airbnb", "coinbase", "robinhood", "plaid", "figma",
  "notion", "linear", "vercel", "supabase", "discord", "canva",
  "duolingo", "databricks", "snowflake", "hashicorp", "gitlab",
  "twilio", "sendgrid", "segment", "brex", "ramp", "mercury",
  "gusto", "rippling", "deel", "remote", "lattice", "culture-amp",
  "asana", "monday", "clickup", "notion", "airtable", "coda",
  "loom", "miro", "figma", "framer", "webflow", "bubble",
  "shopify", "klaviyo", "gorgias", "postscript", "attentive",
  "hubspot", "intercom", "zendesk", "freshdesk", "drift",
  "salesloft", "outreach", "apollo", "zoominfo", "clearbit",
  "datadog", "new-relic", "splunk", "elastic", "mongodb",
  "redis", "cockroachdb", "planetscale", "neon", "turso",
  "sentry", "pagerduty", "incident-io", "rootly", "firehydrant",
  "openai", "anthropic", "cohere", "huggingface", "mistral",
  "scale-ai", "labelbox", "weights-biases", "modal", "replicate",
  "stripe", "adyen", "checkout", "mollie", "razorpay", "paystack",
  "flutterwave", "chipper", "sendwave", "wise", "revolut",
  "chime", "dave", "current", "varo", "nubank", "monzo",
  "klarna", "affirm", "afterpay", "sezzle", "perpay",
  "uber", "lyft", "doordash", "instacart", "gopuff",
  "convoy", "flexport", "project44", "foursite", "samsara",
  "waymo", "cruise", "aurora", "kodiak", "torc",
  "spacex", "relativity-space", "astranis", "planet", "spire",
  "palantir", "c3ai", "veritone", "evolution-ai", "covariant",
  "cloudflare", "fastly", "akamai", "ns1", "dnsimple",
  "tailscale", "ngrok", "planetscale", "render", "fly",
  "github", "gitlab", "bitbucket", "linear", "shortcut",
  "jira", "confluence", "notion", "slab", "guru",
  "zoom", "whereby", "daily", "agora", "twilio",
  "sendbird", "stream", "pubnub", "ably", "pusher",
  "twitch", "discord", "guilded", "revolt", "revolt",
  "roblox", "unity", "epic-games", "riot-games", "bungie",
  "calm", "headspace", "woebot", "cerebral", "done",
  "hims", "ro", "nurx", "wisp", "brightside",
  "oscar", "devoted", "alignment", "clover", "cityblock",
  "forward", "carbon-health", "crossover-health", "one-medical",
  "peloton", "whoop", "oura", "levels", "dexcom",
  "benchling", "ginkgo", "twist", "zymergen", "moderna",
  "relativity", "clio", "ironclad", "contract-pod-ai", "docusign",
  "procore", "autodesk", "trimble", "bentley", "hexagon",
  "toast", "olo", "itsacheckmate", "thanx", "paytronix",
  "faire", "retailer-solutions", "storefront", "locally",
  "etsy", "poshmark", "depop", "vinted", "threadup",
  "warby-parker", "allbirds", "everlane", "rothys", "atoms",
  "nerdwallet", "creditkarma", "mint", "personalcapital", "betterment",
  "wealthfront", "robinhood", "public", "m1-finance", "acorns",
];

/**
 * Crawl a single Lever company via their public JSON API
 */
async function crawlLeverCompany(slug) {
  const apiUrl = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  try {
    const { data } = await axios.get(apiUrl, {
      timeout: 8000,
      headers: { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" },
    });

    if (!Array.isArray(data) || data.length === 0) return [];

    return data.map((job) => ({
      external_id: `lever_${job.id}`,
      title: job.text || "Unknown Role",
      company: formatCompanyName(slug),
      location: extractLocation(job),
      remote: isRemote(job),
      type: normalizeCommitment(job.categories?.commitment),
      description: job.descriptionPlain?.slice(0, 500) || "",
      // hostedUrl is Lever's own page — direct, clean, no job board
      apply_url: job.hostedUrl || `https://jobs.lever.co/${slug}`,
      company_logo: null,
      logo_color: hashColor(slug),
      posted_at: job.createdAt
        ? new Date(job.createdAt).toISOString()
        : new Date().toISOString(),
      source: "lever",
      featured: false,
    }));
  } catch (err) {
    return []; // 404 = company not on Lever, skip silently
  }
}

/**
 * Main runner — crawl all Lever companies in batches
 */
async function runLeverCrawler({ slugs = LEVER_COMPANIES, onProgress } = {}) {
  let totalJobs = 0;
  let companiesProcessed = 0;
  const errors = [];

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map((slug) => crawlLeverCompany(slug))
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
        errors.push(`DB upsert: ${e.message}`)
      );
    }

    companiesProcessed += batch.length;

    if (onProgress) {
      onProgress({ companiesProcessed, total: slugs.length, totalJobs });
    }

    console.log(
      `[LEVER] ${companiesProcessed}/${slugs.length} companies | ${totalJobs} jobs saved`
    );

    await sleep(DELAY_MS);
  }

  return { companiesProcessed, totalJobs, errors };
}

/**
 * Discover NEW Lever companies by scraping Lever's own job board directory.
 * Returns slugs not yet in our known list.
 */
async function discoverNewLeverCompanies() {
  try {
    const { data } = await axios.get("https://jobs.lever.co", {
      timeout: 10000,
      headers: { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" },
    });

    const slugRegex = /jobs\.lever\.co\/([a-z0-9_-]+)/gi;
    const found = new Set();
    let match;
    while ((match = slugRegex.exec(data)) !== null) {
      found.add(match[1]);
    }

    const newSlugs = [...found].filter((s) => !LEVER_COMPANIES.includes(s));
    console.log(`[LEVER DISCOVER] Found ${newSlugs.length} new companies`);
    return newSlugs;
  } catch (err) {
    console.error("[LEVER DISCOVER]", err.message);
    return [];
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function extractLocation(job) {
  if (job.workplaceType === "remote") return "Remote";
  const loc = job.categories?.location;
  if (loc) return loc;
  if (job.workplaceType === "hybrid") return "Hybrid";
  return "Unknown";
}

function isRemote(job) {
  return (
    job.workplaceType === "remote" ||
    /remote|anywhere|worldwide/i.test(job.categories?.location || "")
  );
}

function normalizeCommitment(c = "") {
  if (!c) return "Full-time";
  if (/part/i.test(c)) return "Part-time";
  if (/contract|freelance/i.test(c)) return "Contract";
  if (/intern/i.test(c)) return "Internship";
  return "Full-time";
}

function formatCompanyName(slug) {
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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

module.exports = { runLeverCrawler, crawlLeverCompany, discoverNewLeverCompanies, LEVER_COMPANIES };
