const axios = require("axios");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// RECRUITEE CRAWLER
//
// Recruitee hosts public career sites for thousands of SMBs, heavily
// European + global, lots of non-tech roles — great for broadening
// beyond US tech.
//
// Public API per company:
//   https://{slug}.recruitee.com/api/offers/
// Returns offers with a public careers_url that goes DIRECTLY to the
// company's own job page — no middleman.
//
// Crawler skips any slug that 404s or returns empty.
// ─────────────────────────────────────────────────────────────

const CONCURRENCY = 6;
const DELAY_MS = 300;
const UA = { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" };

// Seed list of known Recruitee companies across sectors.
const RECRUITEE_COMPANIES = [
  "recruitee", "toptal", "miro", "messagebird", "mollie",
  "framer", "bunq", "tiqets", "channable", "studocu",
  "leaseweb", "picnic", "catawiki", "wetransfer", "backbase",
  "mews", "trengo", "sendcloud", "effectory", "homerun",
  "gitpod", "contentful", "n26", "gorillas", "wefox",
  "personio", "celonis", "scalable", "raisin", "solarisbank",
  "kontist", "getsafe", "clark", "moonfare", "penta",
  "billie", "moss", "pliant", "circula", "finn",
  "vinted", "bolt", "wise", "deliveroo", "glovo",
  "typeform", "factorial", "redpoints", "travelperk", "jobandtalent",
];

async function crawlRecruiteeCompany(slug) {
  const url = `https://${slug}.recruitee.com/api/offers/`;
  try {
    const { data } = await axios.get(url, { timeout: 9000, headers: UA });
    if (!data || !Array.isArray(data.offers)) return [];

    return data.offers.map((o) => {
      const loc = [o.city, o.country].filter(Boolean).join(", ") || o.location || "";
      const remote = /remote/i.test(`${o.title} ${loc} ${o.remote || ""}`) || o.remote === true;
      return {
        external_id: `recruitee_${slug}_${o.id}`,
        title: o.title || "",
        company: o.company_name || slug,
        location: loc,
        remote,
        type: o.employment_type_code || o.kind || "",
        description: (o.description || "").replace(/<[^>]+>/g, " ").slice(0, 500),
        apply_url: o.careers_url || o.careers_apply_url,  // DIRECT to company page
        source: "recruitee",
        posted_at: o.published_at || o.created_at || new Date().toISOString(),
      };
    }).filter((j) => j.title && j.apply_url);
  } catch (err) {
    return [];
  }
}

async function runRecruiteeCrawler({ slugs = RECRUITEE_COMPANIES, onProgress } = {}) {
  let totalJobs = 0;
  let processed = 0;

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((s) => crawlRecruiteeCompany(s)));
    for (const jobs of results) {
      if (jobs.length) {
        await upsertJobs(jobs).catch((e) => console.error("[RECRUITEE upsert]", e.message));
        totalJobs += jobs.length;
      }
    }
    processed += batch.length;
    if (onProgress) onProgress({ source: "recruitee", processed, totalJobs });
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`[RECRUITEE] Done — ${totalJobs} jobs from ${processed} companies`);
  return { totalJobs, companiesProcessed: processed };
}

module.exports = { runRecruiteeCrawler, crawlRecruiteeCompany, RECRUITEE_COMPANIES };
