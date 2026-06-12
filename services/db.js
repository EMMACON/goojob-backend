const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Jobs Table Helpers ───────────────────────────────────────

/**
 * Search jobs by keyword, location, and type
 */
async function searchJobs({ query = "", location = "", type = "", remote, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;

  let q = supabase
    .from("jobs")
    .select("*", { count: "exact" })
    .order("posted_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (query) {
    // Full-text search across title, company, description
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

/**
 * Upsert jobs (insert or update by external_id)
 */
async function upsertJobs(jobs) {
  const { data, error } = await supabase
    .from("jobs")
    .upsert(jobs, { onConflict: "external_id" });
  if (error) throw error;
  return data;
}

/**
 * Get a single job by ID
 */
async function getJobById(id) {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get featured/recent jobs for homepage
 */
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

/**
 * Log a click/apply event for analytics
 */
async function logClick(jobId, userIp) {
  await supabase.from("job_clicks").insert({ job_id: jobId, user_ip: userIp });
}

module.exports = { supabase, searchJobs, upsertJobs, getJobById, getFeaturedJobs, logClick };
