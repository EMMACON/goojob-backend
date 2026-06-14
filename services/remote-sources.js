const axios = require("axios");

// ─────────────────────────────────────────────────────────────
// REMOTE-NATIVE JOB SOURCES (free APIs, global remote, mostly
// direct-to-company links). These fit a worldwide remote audience
// far better than Adzuna's US/UK skew.
//
//   • Remotive   — https://remotive.com/api/remote-jobs
//   • RemoteOK   — https://remoteok.com/api
//   • Arbeitnow  — https://www.arbeitnow.com/api/job-board-api
//
// All three are public, key-less, and return links that usually go
// straight to the company. We normalize them to our standard job
// shape and tag source so the frontend can badge appropriately.
// Results are fetched live and cached briefly to stay fast.
// ─────────────────────────────────────────────────────────────

const TIMEOUT = 8000;
const UA = { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" };

// Short in-memory cache per source (these endpoints return big lists;
// we cache the whole list and filter locally per search).
const cache = { remotive: null, remoteok: null, arbeitnow: null };
const CACHE_TTL = 1000 * 60 * 15; // 15 minutes

function fresh(entry) {
  return entry && Date.now() - entry.at < CACHE_TTL;
}

function matchesQuery(job, q) {
  if (!q) return true;
  const hay = `${job.title} ${job.company} ${job.description} ${(job.tags || []).join(" ")}`.toLowerCase();
  // match if ANY query word appears
  return q.toLowerCase().split(/\s+/).filter(Boolean).some((w) => hay.includes(w));
}

// ─── Remotive ─────────────────────────────────────────────────
async function loadRemotive() {
  if (fresh(cache.remotive)) return cache.remotive.data;
  try {
    const { data } = await axios.get("https://remotive.com/api/remote-jobs", {
      timeout: TIMEOUT, headers: UA,
    });
    const jobs = (data.jobs || []).map((j) => ({
      id: `remotive_${j.id}`,
      external_id: `remotive_${j.id}`,
      title: j.title || "",
      company: j.company_name || "",
      location: j.candidate_required_location || "Remote",
      remote: true,
      type: j.job_type || "",
      description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 400),
      apply_url: j.url,            // Remotive landing; resolver may upgrade
      tags: j.tags || [],
      source: "remotive",
      posted_at: j.publication_date || new Date().toISOString(),
    })).filter((j) => j.title && j.apply_url);
    cache.remotive = { at: Date.now(), data: jobs };
    return jobs;
  } catch (e) {
    console.error("[remotive]", e.message);
    return cache.remotive?.data || [];
  }
}

// ─── RemoteOK ─────────────────────────────────────────────────
async function loadRemoteOK() {
  if (fresh(cache.remoteok)) return cache.remoteok.data;
  try {
    const { data } = await axios.get("https://remoteok.com/api", {
      timeout: TIMEOUT, headers: UA,
    });
    // First element is metadata/legal — skip non-job entries
    const jobs = (Array.isArray(data) ? data : [])
      .filter((j) => j && j.id && j.position)
      .map((j) => ({
        id: `remoteok_${j.id}`,
        external_id: `remoteok_${j.id}`,
        title: j.position || "",
        company: j.company || "",
        location: j.location || "Remote",
        remote: true,
        type: "",
        description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 400),
        apply_url: j.apply_url || j.url,   // often direct to company
        tags: j.tags || [],
        source: "remoteok",
        posted_at: j.date || new Date().toISOString(),
      }))
      .filter((j) => j.title && j.apply_url);
    cache.remoteok = { at: Date.now(), data: jobs };
    return jobs;
  } catch (e) {
    console.error("[remoteok]", e.message);
    return cache.remoteok?.data || [];
  }
}

// ─── Arbeitnow ────────────────────────────────────────────────
async function loadArbeitnow() {
  if (fresh(cache.arbeitnow)) return cache.arbeitnow.data;
  try {
    const { data } = await axios.get("https://www.arbeitnow.com/api/job-board-api", {
      timeout: TIMEOUT, headers: UA,
    });
    const jobs = (data.data || []).map((j) => ({
      id: `arbeitnow_${j.slug}`,
      external_id: `arbeitnow_${j.slug}`,
      title: j.title || "",
      company: j.company_name || "",
      location: j.location || (j.remote ? "Remote" : ""),
      remote: !!j.remote,
      type: (j.job_types || []).join(", "),
      description: (j.description || "").replace(/<[^>]+>/g, " ").slice(0, 400),
      apply_url: j.url,            // Arbeitnow link; resolver may upgrade
      tags: j.tags || [],
      source: "arbeitnow",
      posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : new Date().toISOString(),
    })).filter((j) => j.title && j.apply_url);
    cache.arbeitnow = { at: Date.now(), data: jobs };
    return jobs;
  } catch (e) {
    console.error("[arbeitnow]", e.message);
    return cache.arbeitnow?.data || [];
  }
}

/**
 * Search all three remote sources for a query.
 * Returns a combined, de-duplicated list (tagged source_type set by caller).
 */
async function searchRemoteSources({ query = "", remote, limit = 15 }) {
  const [a, b, c] = await Promise.all([loadRemotive(), loadRemoteOK(), loadArbeitnow()]);
  let all = [...a, ...b, ...c];

  // If user explicitly wants on-site only, these remote sources don't apply
  if (remote === false) return { jobs: [], total: 0 };

  all = all.filter((j) => matchesQuery(j, query));

  // Dedupe by title+company across the three sources
  const seen = new Set();
  const deduped = [];
  for (const j of all) {
    const key = `${j.title.toLowerCase()}|${j.company.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(j); }
  }

  return { jobs: deduped.slice(0, limit), total: deduped.length };
}

module.exports = { searchRemoteSources };
