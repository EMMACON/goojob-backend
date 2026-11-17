const { listJobsByPrefix, deleteExternalIds, getPostedAtMap, deletePostedBefore } = require("./db");

const COARSE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const INDEX_MAX_AGE_DAYS = 180;

function diffStaleIds(existingIds, seenIds) {
  const seen = new Set(seenIds || []);
  const stale = [];
  for (const id of existingIds || []) {
    if (id && !seen.has(id)) stale.push(id);
  }
  return stale;
}

async function keepFirstPostedAt(jobs) {
  const out = (jobs || []).map((job) => ({ ...job }));
  const sticky = out.filter((job) => job.date_quality === "coarse" || job.date_quality === "unknown");
  let existing = new Map();
  if (sticky.length && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      existing = await getPostedAtMap(sticky.map((job) => job.external_id));
    } catch (err) {
      console.error("[expiry] could not read existing posted_at:", err.message);
    }
  }
  const now = Date.now();
  for (const job of out) {
    if (job.date_quality === "coarse") {
      job.posted_at = existing.get(job.external_id) || new Date(now - COARSE_AGE_MS).toISOString();
    } else if (job.date_quality === "unknown") {
      job.posted_at = existing.get(job.external_id) || new Date(now).toISOString();
    }
    delete job.date_quality;
    delete job._externalPath;
  }
  return out;
}

async function expireMissing({ prefix, seenIds }) {
  if (!/^[a-z0-9_-]{6,160}$/i.test(prefix || "")) {
    throw new Error(`refusing to expire unsafe prefix ${prefix}`);
  }
  const rows = await listJobsByPrefix(prefix);
  const stale = diffStaleIds(rows.map((row) => row.external_id), seenIds);
  if (stale.length) await deleteExternalIds(stale);
  return { scanned: rows.length, deleted: stale.length };
}

async function expireOlderThan(days = INDEX_MAX_AGE_DAYS) {
  const iso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await deletePostedBefore(iso);
  return { olderThan: iso, days };
}

module.exports = {
  INDEX_MAX_AGE_DAYS,
  diffStaleIds,
  keepFirstPostedAt,
  expireMissing,
  expireOlderThan,
};
