const express = require("express");
const router = express.Router();
const { upsertJobs, getRecentJobs } = require("../services/db");
const axios = require("axios");

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES — add curated jobs straight from a hidden web page.
// Protected by the same ADMIN_KEY used for the crawler.
// The frontend admin page sends the key in the x-admin-key header.
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REST = `${SUPABASE_URL}/rest/v1`;
const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// Middleware: require the admin key
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function makeId(url) {
  return "manual_" + String(url).replace(/[^a-zA-Z0-9]/g, "").slice(-48);
}

// Normalize one job object from the admin form/paste
function normalizeJob(j) {
  const title = (j.title || "").trim();
  const company = (j.company || "").trim();
  const apply_url = (j.apply_url || j.url || "").trim();
  if (!title || !company || !/^https?:\/\//i.test(apply_url)) return null;

  return {
    external_id: makeId(apply_url),
    title,
    company,
    location: (j.location || "").trim(),
    remote: j.remote === true || /^(true|yes|remote|1)$/i.test(String(j.remote || "").trim()),
    type: (j.type || "").trim(),
    description: (j.description || "").trim().slice(0, 600),
    apply_url,
    source: "manual",
    posted_at: new Date().toISOString(),  // always fresh
  };
}

/**
 * POST /api/admin/jobs
 * Body: { jobs: [ {title, company, apply_url, ...}, ... ] }
 * Adds one or many curated jobs.
 */
router.post("/jobs", requireAdmin, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.jobs) ? req.body.jobs : [req.body];
    const jobs = incoming.map(normalizeJob).filter(Boolean);
    const rejected = incoming.length - jobs.length;

    if (jobs.length === 0) {
      return res.status(400).json({
        error: "No valid jobs. Each needs a title, company, and a valid https:// apply link.",
        rejected,
      });
    }

    await upsertJobs(jobs);
    res.json({ ok: true, added: jobs.length, rejected });
  } catch (err) {
    console.error("[admin/jobs POST]", err.message);
    res.status(500).json({ error: "Could not add jobs." });
  }
});

/**
 * GET /api/admin/jobs
 * Lists the manually-added jobs (most recent first) so you can review/delete.
 */
router.get("/jobs", requireAdmin, async (req, res) => {
  try {
    const { data } = await axios.get(
      `${REST}/jobs?source=eq.manual&order=posted_at.desc&limit=200&select=*`,
      { headers: sbHeaders, timeout: 9000 }
    );
    res.json({ jobs: data || [] });
  } catch (err) {
    console.error("[admin/jobs GET]", err.message);
    res.status(500).json({ error: "Could not load jobs." });
  }
});

/**
 * DELETE /api/admin/jobs/:externalId
 * Removes a manually-added job.
 */
router.delete("/jobs/:externalId", requireAdmin, async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.externalId);
    await axios.delete(`${REST}/jobs?external_id=eq.${id}`, {
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      timeout: 9000,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/jobs DELETE]", err.message);
    res.status(500).json({ error: "Could not delete job." });
  }
});

module.exports = router;
