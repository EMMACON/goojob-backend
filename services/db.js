const { createClient } = require("@supabase/supabase-js");

// We only use Supabase for database queries — NOT realtime.
// Disabling realtime avoids the Node.js WebSocket requirement entirely.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      // Disable realtime — we don't need live subscriptions
      params: { eventsPerSecond: 0 },
    },
    global: {
      headers: { "x-application-name": "goojob" },
    },
  }
);

// ─── Jobs Table Helpers ───────────────────────────────────────

async function searchJobs({ query = "", location = "", type = "", remote, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;

  let q = supabase
    .from("jobs")
    .select("*", { count: "exact" })
    .order("posted_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (query) {
    q = q.or(
      `title.ilike.%${query}%,company.ilike.%${query}%,description.ilike.%${query}%`
    );
  }
  if (location) q = q.ilike("location", `%${location}%`);
  if (type) q = q.eq("type", type);
  if (remote !== undefined) q = q.eq("remote", remote);

  const { data, error, count } = await q;
  if (error) throw error;

  return { jobs: data, total: count, page, limit };
}

async function upsertJobs(jobs) {
  const { data, error } = await supabase
    .from("jobs")
    .upsert(jobs, { onConflict: "external_id" });
  if (error) throw error;
  return data;
}

async function getJobById(id) {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function getFeaturedJobs(limit = 10) {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("featured", true)
    .order("posted_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function logClick(jobId, userIp) {
  await supabase.from("job_clicks").insert({ job_id: jobId, user_ip: userIp });
}

module.exports = { supabase, searchJobs, upsertJobs, getJobById, getFeaturedJobs, logClick };
