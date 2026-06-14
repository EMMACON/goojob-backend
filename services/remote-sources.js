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
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return true;

  const title = (job.title || "").toLowerCase();
  const tags = (job.tags || []).join(" ").toLowerCase();
  const company = (job.company || "").toLowerCase();
  const body = (job.description || "").toLowerCase();

  // Relevance scoring: a match in the TITLE matters far more than the
  // description. We require the job to clear a threshold so loosely
  // related jobs (e.g. "Director" matching "video editor") drop out.
  let score = 0;
  for (const w of words) {
    if (title.includes(w)) score += 3;        // title hit = strong
    else if (tags.includes(w)) score += 2;    // tag hit = good
    else if (company.includes(w)) score += 1; // company hit = weak
    else if (body.includes(w)) score += 0.5;  // body-only = very weak
  }

  // Require at least one strong/medium signal, OR most words present.
  // Threshold scales with how many words the user typed.
  const titleHits = words.filter((w) => title.includes(w)).length;
  const needed = Math.max(2, words.length * 1.5);
  return titleHits >= 1 && score >= needed;
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
async function searchRemoteSources({ query = "", remote, limit = 25, page = 1, offset = 0 }) {
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

  // Pagination: slice the requested window out of the full matched set
  const start = offset || (page - 1) * limit;
  return { jobs: deduped.slice(start, start + limit), total: deduped.length };
}

module.exports = { searchRemoteSources };
