const axios = require("axios");

// ─────────────────────────────────────────────────────────────
// ADZUNA AGGREGATOR SOURCE
// Adzuna aggregates jobs across ALL sectors (video editing, media,
// hospitality, trades, etc.) — filling the gaps the ATS crawlers
// (Greenhouse/Lever/Ashby/Workable) can't reach.
//
// These results are served LIVE at search time (not crawled into
// the DB) and clearly labeled "Via Adzuna" so users know the
// difference vs. your direct-company jobs.
//
// Free API: register at https://developer.adzuna.com/
//   -> you get an APP_ID and an APP_KEY
//   -> set them as env vars ADZUNA_APP_ID and ADZUNA_APP_KEY
// ─────────────────────────────────────────────────────────────

const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;

// Adzuna has country-specific endpoints. "gb" and "us" have the
// best coverage. We query a default country but allow override.
const DEFAULT_COUNTRY = process.env.ADZUNA_COUNTRY || "gb";

function isConfigured() {
  return Boolean(APP_ID && APP_KEY);
}

/**
 * Search Adzuna live.
 * Returns jobs normalized to the same shape as our DB jobs,
 * tagged source: "adzuna" so the frontend can badge them.
 */
async function searchAdzuna({ query = "", remote, page = 1, limit = 20, country = DEFAULT_COUNTRY }) {
  if (!isConfigured()) return { jobs: [], total: 0 };
  if (!query.trim()) return { jobs: [], total: 0 };

  const safePage = Math.max(1, Math.min(Number(page) || 1, 50));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));

  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${safePage}`;
  const params = {
    app_id: APP_ID,
    app_key: APP_KEY,
    results_per_page: safeLimit,
    what: query.trim(),
    "content-type": "application/json",
  };
  // Adzuna doesn't have a strict "remote" flag, but we can bias the
  // keyword search toward remote when the user filters for it.
  if (remote === true) params.what = `${query.trim()} remote`;

  try {
    const { data } = await axios.get(url, { params, timeout: 9000 });

    const jobs = (data.results || []).map((j) => {
      const company = j.company?.display_name || "Company";
      const loc = j.location?.display_name || "";
      const isRemote = /remote|work from home|wfh|anywhere/i.test(
        `${j.title} ${j.description} ${loc}`
      );
      return {
        // prefix id so it never collides with DB ids
        id: `adzuna_${j.id}`,
        external_id: `adzuna_${j.id}`,
        title: j.title || "",
        company,
        location: loc,
        remote: isRemote,
        type: j.contract_time || "",
        description: (j.description || "").slice(0, 400),
        apply_url: j.redirect_url, // Adzuna's redirect → often lands on company site
        source: "adzuna",
        posted_at: j.created || new Date().toISOString(),
      };
    }).filter((j) => j.title && j.apply_url);

    return { jobs, total: data.count || jobs.length };
  } catch (err) {
    console.error("[ADZUNA]", err.response?.status, err.message);
    return { jobs: [], total: 0 };
  }
}

module.exports = { searchAdzuna, isConfigured };
