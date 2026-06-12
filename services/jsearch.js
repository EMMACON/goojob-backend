const axios = require("axios");

const JSEARCH_HOST = "jsearch.p.rapidapi.com";
const JSEARCH_KEY = process.env.JSEARCH_API_KEY;

/**
 * Search jobs via JSearch (RapidAPI)
 * Returns jobs with direct company apply URLs
 */
async function searchJSearchAPI({ query, location = "", remote = false, page = 1 }) {
  const params = {
    query: location ? `${query} in ${location}` : query,
    page: String(page),
    num_pages: "1",
    date_posted: "all",
  };

  if (remote) params.remote_jobs_only = "true";

  const response = await axios.get("https://jsearch.p.rapidapi.com/search", {
    params,
    headers: {
      "X-RapidAPI-Key": JSEARCH_KEY,
      "X-RapidAPI-Host": JSEARCH_HOST,
    },
    timeout: 8000,
  });

  return normalizeJSearchResults(response.data?.data || []);
}

/**
 * Normalize JSearch results to our internal format
 */
function normalizeJSearchResults(rawJobs) {
  return rawJobs.map((job) => ({
    external_id: job.job_id,
    title: job.job_title,
    company: job.employer_name,
    location: buildLocation(job),
    remote: job.job_is_remote || false,
    type: normalizeJobType(job.job_employment_type),
    description: job.job_description?.slice(0, 500) || "",
    apply_url: pickBestURL(job),           // ← direct company link, no middleman
    company_logo: job.employer_logo || null,
    posted_at: job.job_posted_at_datetime_utc || new Date().toISOString(),
    source: "jsearch",
    featured: false,
  }));
}

function buildLocation(job) {
  if (job.job_is_remote) return "Remote";
  const parts = [job.job_city, job.job_state, job.job_country].filter(Boolean);
  return parts.join(", ") || "Unknown";
}

function normalizeJobType(type) {
  if (!type) return "Full-time";
  const t = type.toUpperCase();
  if (t.includes("FULL")) return "Full-time";
  if (t.includes("PART")) return "Part-time";
  if (t.includes("CONTRACT")) return "Contract";
  if (t.includes("INTERN")) return "Internship";
  return "Full-time";
}

/**
 * Pick the most direct URL possible — prefer company site over job boards
 */
function pickBestURL(job) {
  const boardDomains = ["indeed.com", "linkedin.com", "glassdoor.com", "monster.com", "ziprecruiter.com"];

  // Try apply_options in order, pick first one NOT from a job board
  const options = job.apply_options || [];
  for (const opt of options) {
    const url = opt.apply_link || "";
    const isBoard = boardDomains.some((d) => url.includes(d));
    if (!isBoard) return url;
  }

  // Fallback: use whatever direct link is available
  return job.job_apply_link || options[0]?.apply_link || "#";
}

module.exports = { searchJSearchAPI };
