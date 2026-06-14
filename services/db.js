const axios = require("axios");

// ─────────────────────────────────────────────────────────────
// Direct Supabase REST API client (no @supabase/supabase-js)
// Plain HTTPS requests to Supabase's REST endpoint.
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// ─── Sanitize user input for PostgREST filters ────────────────
function cleanSearchTerm(str, maxLen = 80) {
  return String(str || "")
    .slice(0, maxLen)
    .replace(/[*(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Expand a query into related word stems ───────────────────
// Turns "editing" into matching "edit", "editor", "edits" etc.
// by stripping common English suffixes to a stem, then matching
// that stem as a wildcard. Also splits multi-word queries so
// each word is matched independently (OR), widening results.
function buildSearchTerms(rawQuery) {
  const q = cleanSearchTerm(rawQuery);
  if (!q) return [];

  const words = q.split(" ").filter((w) => w.length >= 2);
  const stems = new Set();

  for (const word of words) {
    const lower = word.toLowerCase();
    stems.add(lower);

    // crude stemming: strip common suffixes to a root
    let stem = lower
      .replace(/(ing|ers|er|ed|es|s|ation|ment|ist|ant|ent)$/i, "");
    // only use the stem if it's still meaningful (>=3 chars)
    if (stem.length >= 3 && stem !== lower) {
      stems.add(stem);
    }
  }
  return [...stems];
}

// ─── Search jobs ──────────────────────────────────────────────
// Score a DB job for relevance to the search words (same philosophy
// as the remote-sources scorer: title hits matter most).
function scoreJob(job, words) {
  if (!words.length) return 1;
  const title = (job.title || "").toLowerCase();
  const company = (job.company || "").toLowerCase();
  const body = (job.description || "").toLowerCase();
  let score = 0;
  for (const w of words) {
    if (title.includes(w)) score += 3;
    else if (company.includes(w)) score += 1;
    else if (body.includes(w)) score += 0.5;
  }
  return score;
}

async function searchJobs({ query = "", location = "", type = "", remote, page = 1, limit = 20 }) {
  const safePage = Math.max(1, Math.min(Number(page) || 1, 500));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));

  const loc = cleanSearchTerm(location);
  const typeClean = cleanSearchTerm(type, 30);
  const terms = buildSearchTerms(query);

  const params = new URLSearchParams();
  params.set("select", "*");
  // Fetch a larger candidate POOL (newest first), then we rank by
  // relevance in-memory and paginate the ranked list. This way a
  // strong title match always beats a loosely-related newer job.
  params.set("order", "posted_at.desc");
  params.set("limit", "200");   // candidate pool size

  if (terms.length) {
    const orClauses = [];
    for (const t of terms) {
      orClauses.push(`title.ilike.*${t}*`);
      orClauses.push(`company.ilike.*${t}*`);
      orClauses.push(`description.ilike.*${t}*`);
    }
    params.set("or", `(${orClauses.join(",")})`);
  }
  if (loc) params.append("location", `ilike.*${loc}*`);
  if (typeClean) params.append("type", `eq.${typeClean}`);
  if (remote !== undefined) params.append("remote", `eq.${remote === true}`);

  const res = await axios.get(`${REST}/jobs?${params.toString()}`, {
    headers: { ...headers, Prefer: "count=exact" },
    timeout: 10000,
  });

  // Rank the candidate pool by relevance score (desc), then by recency.
  const scoreWords = query
    ? query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    : [];
  const ranked = (res.data || [])
    .map((j) => ({ job: j, score: scoreJob(j, scoreWords) }))
    .filter((x) => scoreWords.length === 0 || x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.job.posted_at || 0) - new Date(a.job.posted_at || 0);
    })
    .map((x) => x.job);

  // Paginate the ranked list
  const start = (safePage - 1) * safeLimit;
  const pageJobs = ranked.slice(start, start + safeLimit);

  return { jobs: pageJobs, total: ranked.length, page: safePage, limit: safeLimit };
}

// ─── Upsert jobs ──────────────────────────────────────────────
async function upsertJobs(jobs) {
  if (!jobs || jobs.length === 0) return [];
  const res = await axios.post(
    `${REST}/jobs?on_conflict=external_id`,
    jobs,
    {
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      timeout: 15000,
    }
  );
  return res.data;
}

// ─── Get one job ──────────────────────────────────────────────
async function getJobById(id) {
  const safeId = encodeURIComponent(String(id).slice(0, 64));
  const res = await axios.get(`${REST}/jobs?id=eq.${safeId}&select=*`, {
    headers,
    timeout: 8000,
  });
  return res.data[0] || null;
}

// ─── Featured jobs ────────────────────────────────────────────
async function getFeaturedJobs(limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const res = await axios.get(
    `${REST}/jobs?featured=eq.true&order=posted_at.desc&limit=${safeLimit}&select=*`,
    { headers, timeout: 8000 }
  );
  return res.data;
}

// ─── Log click ────────────────────────────────────────────────
async function logClick(jobId, userIp) {
  try {
    await axios.post(
      `${REST}/job_clicks`,
      { job_id: String(jobId).slice(0, 64), user_ip: String(userIp || "").slice(0, 64) },
      { headers: { ...headers, Prefer: "return=minimal" }, timeout: 5000 }
    );
  } catch (e) {
    // non-critical, ignore
  }
}

module.exports = { searchJobs, upsertJobs, getJobById, getFeaturedJobs, logClick };
