const axios = require("axios");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// SMARTRECRUITERS CRAWLER
//
// SmartRecruiters hosts public job boards for thousands of companies,
// including many NON-TECH and international employers — broadening
// coverage beyond the tech-heavy ATS platforms.
//
// Public API per company:
//   https://api.smartrecruiters.com/v1/companies/{slug}/postings
// Returns structured postings; each has a public apply URL of form:
//   https://jobs.smartrecruiters.com/{slug}/{postingId}
// These are DIRECT company application pages — no middleman.
//
// Crawler skips any slug that 404s or returns empty, so speculative
// company slugs in the seed list are safe.
// ─────────────────────────────────────────────────────────────

const CONCURRENCY = 6;
const DELAY_MS = 300;
const UA = { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" };

// Seed list of known SmartRecruiters companies across sectors.
const SR_COMPANIES = [
  // Tech / consumer
  "Square", "Twitch", "Bosch", "Visa", "McDonalds",
  "Ubisoft", "IKEA", "LinkedIn", "Skype",
  // Retail / FMCG / non-tech (SmartRecruiters' strength)
  "Carrefour", "Aldi", "Lidl", "Tesco", "Metro",
  "Avon", "LOreal", "Nestle", "Unilever", "Danone",
  "CocaCola", "PepsiCo", "Mars", "Mondelez",
  // Finance / services
  "Allianz", "AXA", "ING", "Santander", "BNPParibas",
  "Deloitte", "KPMG", "PwC", "Accenture", "Capgemini",
  // Travel / hospitality
  "Marriott", "Hilton", "Accor", "IHG", "BookingCom",
  // Logistics / industrial
  "DHL", "Maersk", "Bosch", "Siemens", "Schneider",
  // Health / pharma
  "Bayer", "Sanofi", "Novartis", "Roche", "GSK",
  // Media / telecom
  "Vodafone", "Orange", "Telefonica", "BBC", "Spotify",
];

async function crawlSmartRecruitersCompany(slug) {
  const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`;
  try {
    const { data } = await axios.get(url, { timeout: 9000, headers: UA });
    if (!data || !Array.isArray(data.content)) return [];

    return data.content.map((p) => {
      const city = p.location?.city || "";
      const country = p.location?.country || "";
      const loc = [city, country].filter(Boolean).join(", ");
      const remote = !!p.location?.remote || /remote/i.test(p.name || "");
      // IMPORTANT: p.ref is the API endpoint (returns raw JSON) — never
      // send users there. Use the human-facing posting page instead.
      const applyUrl =
        p.postingUrl ||
        p.applyUrl ||
        `https://jobs.smartrecruiters.com/${slug}/${p.id}`;
      return {
        external_id: `smartrecruiters_${slug}_${p.id}`,
        title: p.name || "",
        company: p.company?.name || slug,
        location: loc,
        remote,
        type: p.typeOfEmployment?.label || "",
        description: (p.jobAd?.sections?.jobDescription?.text || "")
          .replace(/<[^>]+>/g, " ").slice(0, 500),
        apply_url: applyUrl,
        source: "smartrecruiters",
        posted_at: p.releasedDate || p.createdOn || new Date().toISOString(),
      };
    }).filter((j) => j.title && j.apply_url);
  } catch (err) {
    return [];
  }
}

async function runSmartRecruitersCrawler({ slugs = SR_COMPANIES, onProgress } = {}) {
  let totalJobs = 0;
  let processed = 0;

  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((s) => crawlSmartRecruitersCompany(s)));
    for (const jobs of results) {
      if (jobs.length) {
        await upsertJobs(jobs).catch((e) => console.error("[SR upsert]", e.message));
        totalJobs += jobs.length;
      }
    }
    processed += batch.length;
    if (onProgress) onProgress({ source: "smartrecruiters", processed, totalJobs });
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`[SMARTRECRUITERS] Done — ${totalJobs} jobs from ${processed} companies`);
  return { totalJobs, companiesProcessed: processed };
}

module.exports = { runSmartRecruitersCrawler, crawlSmartRecruitersCompany, SR_COMPANIES };
