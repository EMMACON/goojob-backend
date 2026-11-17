const axios = require("axios");
const { normalizeJob } = require("./normalize");
const {
  parseSearchQuery,
  buildJobQuery,
  rankJobs,
  prepareRecentJobs,
  paginate,
  isFresh,
  POOL_LIMIT,
  MAX_JOB_AGE_DAYS,
} = require("./search");

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

const searchCache = new Map();
const SEARCH_CACHE_TTL = 60 * 1000;
const countCache = { at: 0, value: null };
const COUNT_CACHE_TTL = 5 * 60 * 1000;
const recentCache = { at: 0, value: null };
const RECENT_CACHE_TTL = 60 * 1000;

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value, max = 80) {
  if (map.size >= max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, { at: Date.now(), value });
}

// ─── Reject links that point at APIs / raw data instead of a real
// job page. Users must always land on a human-readable posting.
function isUserFacingUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!/^https?:\/\//.test(u)) return false;
  if (/\/api\//.test(u)) return false;
  if (/api\.[a-z0-9-]+\./.test(u)) return false;
  if (/\.json(\?|$)/.test(u)) return false;
  if (/\/v\d+\//.test(u) && /api/.test(u)) return false;
  if (/output=csv|format=json/.test(u)) return false;
  return true;
}

async function fetchCandidateJobs(params) {
  const url = `${REST}/jobs?${params.toString()}`;
  try {
    const res = await axios.get(url, { headers, timeout: 8000 });
    const data = Array.isArray(res.data) ? res.data : [];
    return { data, truncated: data.length >= POOL_LIMIT };
  } catch (err) {
    // A rejected filter should not take the search down. Fall back to the
    // first title term, which is the same shape this API has always used.
    if (err.response?.status === 400) {
      const blob = `${params.get("or") || ""} ${params.get("and") || ""}`;
      const title = blob.match(/title\.ilike\.\*([^*]+)\*/);
      if (title) {
        console.error("[search] filter rejected, using a simpler title match");
        const fallback = new URLSearchParams();
        fallback.set("select", params.get("select") || "*");
        fallback.set("order", "posted_at.desc");
        fallback.set("limit", String(POOL_LIMIT));
        fallback.set("or", `(title.ilike.*${title[1]}*,company.ilike.*${title[1]}*)`);
        if (params.get("location")) fallback.set("location", params.get("location"));
        if (params.get("remote")) fallback.set("remote", params.get("remote"));
        const res = await axios.get(`${REST}/jobs?${fallback.toString()}`, { headers, timeout: 8000 });
        const data = Array.isArray(res.data) ? res.data : [];
        return { data, truncated: data.length >= POOL_LIMIT };
      }
    }
    throw err;
  }
}

async function searchJobs({ query = "", location = "", type = "", remote, page = 1, limit = 20 } = {}) {
  const parsed = parseSearchQuery({ query, location, type, remote });
  const cacheKey = JSON.stringify({
    k: parsed.keywords,
    l: parsed.location,
    r: parsed.remote ?? null,
    t: parsed.type || "",
    h: parsed.hybrid,
  });

  let cached = cacheGet(searchCache, cacheKey, SEARCH_CACHE_TTL);
  if (!cached) {
    const params = buildJobQuery(parsed);
    const { data, truncated } = await fetchCandidateJobs(params);
    const fresh = data.filter((job) => isFresh(job));
    const ranked = rankJobs(fresh, parsed);
    cached = { jobs: ranked.jobs, parsed: ranked.parsed, truncated };
    cacheSet(searchCache, cacheKey, cached);
  }

  const pageResult = paginate(cached.jobs, page, limit);
  return {
    ...pageResult,
    parsed: cached.parsed,
    truncated: cached.truncated,
  };
}

async function upsertJobs(jobs) {
  if (!jobs || jobs.length === 0) return [];
  jobs = jobs
    .map((job) => normalizeJob(job))
    .filter((job) => isUserFacingUrl(job.apply_url));
  if (jobs.length === 0) return [];
  const res = await axios.post(
    `${REST}/jobs?on_conflict=external_id`,
    jobs,
    {
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      timeout: 15000,
    }
  );
  searchCache.clear();
  recentCache.value = null;
  countCache.value = null;
  return res.data;
}

async function getJobById(id) {
  const safeId = encodeURIComponent(String(id).slice(0, 64));
  const res = await axios.get(`${REST}/jobs?id=eq.${safeId}&select=*`, {
    headers,
    timeout: 8000,
  });
  const job = res.data[0] || null;
  return job ? normalizeJob(job) : null;
}

async function getFeaturedJobs(limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const res = await axios.get(
    `${REST}/jobs?featured=eq.true&order=posted_at.desc&limit=${safeLimit}&select=*`,
    { headers, timeout: 8000 }
  );
  return (res.data || []).map((job) => normalizeJob(job));
}

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

async function readCount(extra) {
  const params = new URLSearchParams();
  params.set("select", "id");
  if (extra) {
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
  }
  const res = await axios.get(`${REST}/jobs?${params.toString()}`, {
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
    timeout: 8000,
    validateStatus: (status) => status === 200 || status === 206 || status === 416,
  });
  const header = res.headers["content-range"] || "";
  const match = String(header).match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
}

async function getJobCount() {
  if (countCache.value && Date.now() - countCache.at < COUNT_CACHE_TTL) {
    return countCache.value;
  }
  const since = new Date(Date.now() - MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [total, fresh] = await Promise.all([
    readCount(),
    readCount({ posted_at: `gte.${since}` }),
  ]);
  const value = {
    total,
    fresh,
    maxAgeDays: MAX_JOB_AGE_DAYS,
    asOf: new Date().toISOString(),
  };
  countCache.at = Date.now();
  countCache.value = value;
  return value;
}

async function getRecentJobs(limit = 40) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 100));
  if (!recentCache.value || Date.now() - recentCache.at > RECENT_CACHE_TTL) {
    const res = await axios.get(
      `${REST}/jobs?order=posted_at.desc&limit=1000&select=id,external_id,title,company,location,remote,type,description,apply_url,company_logo,logo_color,featured,source,posted_at,created_at`,
      { headers, timeout: 12000 }
    );
    const fresh = (res.data || []).filter((job) => isFresh(job));
    recentCache.value = prepareRecentJobs(fresh, { limit: 100, perCompany: 3 });
    recentCache.at = Date.now();
  }
  const all = recentCache.value.jobs;
  return { jobs: all.slice(0, safeLimit), total: all.length };
}

module.exports = {
  searchJobs,
  upsertJobs,
  getJobById,
  getFeaturedJobs,
  getRecentJobs,
  getJobCount,
  logClick,
};
