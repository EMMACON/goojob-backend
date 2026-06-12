const axios = require("axios");

// ─────────────────────────────────────────────────────────────
// Direct Supabase REST API client (no @supabase/supabase-js)
// This avoids ALL the WebSocket / Node version problems because
// we just make plain HTTPS requests to Supabase's REST endpoint.
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// ─── Search jobs ──────────────────────────────────────────────
async function searchJobs({ query = "", location = "", type = "", remote, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;

  // Build PostgREST query params
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "posted_at.desc");
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  if (query) {
    // OR across title, company, description
    params.set("or", `(title.ilike.*${query}*,company.ilike.*${query}*,description.ilike.*${query}*)`);
  }
  if (location) params.append("location", `ilike.*${location}*`);
  if (type) params.append("type", `eq.${type}`);
  if (remote !== undefined) params.append("remote", `eq.${remote}`);

  const res = await axios.get(`${REST}/jobs?${params.toString()}`, {
    headers: { ...headers, Prefer: "count=exact" },
    timeout: 10000,
  });

  // Total count comes back in the content-range header
  const range = res.headers["content-range"] || "";
  const total = range.includes("/") ? parseInt(range.split("/")[1], 10) : res.data.length;

  return { jobs: res.data, total: isNaN(total) ? res.data.length : total, page, limit };
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
  const res = await axios.get(`${REST}/jobs?id=eq.${id}&select=*`, {
    headers,
    timeout: 8000,
  });
  return res.data[0] || null;
}

// ─── Featured jobs ────────────────────────────────────────────
async function getFeaturedJobs(limit = 10) {
  const res = await axios.get(
    `${REST}/jobs?featured=eq.true&order=posted_at.desc&limit=${limit}&select=*`,
    { headers, timeout: 8000 }
  );
  return res.data;
}

// ─── Log click ────────────────────────────────────────────────
async function logClick(jobId, userIp) {
  try {
    await axios.post(
      `${REST}/job_clicks`,
      { job_id: jobId, user_ip: userIp },
      { headers: { ...headers, Prefer: "return=minimal" }, timeout: 5000 }
    );
  } catch (e) {
    // non-critical, ignore
  }
}

module.exports = { searchJobs, upsertJobs, getJobById, getFeaturedJobs, logClick };
