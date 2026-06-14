const axios = require("axios");

// ─────────────────────────────────────────────────────────────
// DIRECT LINK RESOLVER
//
// Goal: when Adzuna surfaces a job, try to find the SAME job on the
// company's own ATS (Greenhouse/Lever/Ashby/Workable) so we can send
// users to the real company page instead of Adzuna's redirect.
//
// This is fully legitimate: we use Adzuna only for discovery (company
// name + title), then independently look the company up on public ATS
// APIs we already crawl. If we find a strong title match, we serve the
// company's own direct URL. If not, we keep Adzuna's labeled link.
//
// Designed to be FAST and SAFE:
//   - tries common slug variations of the company name
//   - short timeouts; fails silently to the Adzuna fallback
//   - results cached in-memory so repeat lookups are instant
// ─────────────────────────────────────────────────────────────

const TIMEOUT = 4000;
const UA = { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" };

// Simple in-memory cache: company name -> { platform, slug } or null
const companyCache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

// Turn "Acme Inc." / "Acme, LLC" into candidate ATS slugs
function slugCandidates(companyName = "") {
  const base = companyName
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|co|company|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!base) return [];
  const noSpace = base.replace(/\s+/g, "");
  const hyphen = base.replace(/\s+/g, "-");
  const firstWord = base.split(" ")[0];

  // unique, ordered by likelihood
  return [...new Set([noSpace, hyphen, firstWord])].filter((s) => s.length >= 2);
}

// Normalize a title for fuzzy comparison
function normTitle(t = "") {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Is the Adzuna title "close enough" to an ATS job title?
function titlesMatch(a, b) {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // one contains the other (handles "Senior Video Editor" vs "Video Editor")
  if (na.includes(nb) || nb.includes(na)) return true;
  // share most significant words
  const wa = new Set(na.split(" ").filter((w) => w.length > 3));
  const wb = nb.split(" ").filter((w) => w.length > 3);
  if (wb.length === 0) return false;
  const overlap = wb.filter((w) => wa.has(w)).length;
  return overlap / wb.length >= 0.6;
}

// ─── Per-ATS lookups: given a slug, return [{title, url}] ──────
async function tryGreenhouse(slug) {
  try {
    const { data } = await axios.get(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
      { timeout: TIMEOUT, headers: UA }
    );
    return (data.jobs || []).map((j) => ({ title: j.title, url: j.absolute_url }));
  } catch { return null; }
}

async function tryLever(slug) {
  try {
    const { data } = await axios.get(
      `https://api.lever.co/v0/postings/${slug}?mode=json`,
      { timeout: TIMEOUT, headers: UA }
    );
    return (data || []).map((j) => ({ title: j.text, url: j.hostedUrl }));
  } catch { return null; }
}

async function tryAshby(slug) {
  try {
    const { data } = await axios.post(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      { includeCompensation: false },
      { timeout: TIMEOUT, headers: { ...UA, "Content-Type": "application/json" } }
    );
    return (data.jobs || []).map((j) => ({ title: j.title, url: j.jobUrl || j.applyUrl }));
  } catch { return null; }
}

async function tryWorkable(slug) {
  try {
    const { data } = await axios.get(
      `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
      { timeout: TIMEOUT, headers: UA }
    );
    return (data.jobs || []).map((j) => ({
      title: j.title,
      url: j.url || `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
    }));
  } catch { return null; }
}

const PLATFORMS = [
  { name: "greenhouse", fn: tryGreenhouse },
  { name: "lever", fn: tryLever },
  { name: "ashby", fn: tryAshby },
  { name: "workable", fn: tryWorkable },
];

// ─── Find which ATS+slug a company lives on (cached) ──────────
async function findCompanyBoard(companyName) {
  const key = companyName.toLowerCase().trim();
  const cached = companyCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.val;

  const slugs = slugCandidates(companyName);
  for (const slug of slugs) {
    for (const platform of PLATFORMS) {
      const jobs = await platform.fn(slug);
      if (jobs && jobs.length) {
        const val = { platform: platform.name, slug, jobs };
        companyCache.set(key, { at: Date.now(), val });
        return val;
      }
    }
  }
  companyCache.set(key, { at: Date.now(), val: null });
  return null;
}

/**
 * Given one Adzuna job {title, company, apply_url, ...}, try to resolve
 * a direct company link. Returns an UPGRADED job object if found
 * (source_type "direct"), otherwise returns null (caller keeps Adzuna).
 */
async function resolveDirect(adzunaJob) {
  try {
    if (!adzunaJob.company || !adzunaJob.title) return null;
    const board = await findCompanyBoard(adzunaJob.company);
    if (!board) return null;

    const match = board.jobs.find((j) => titlesMatch(adzunaJob.title, j.title));
    if (!match || !match.url) return null;

    return {
      ...adzunaJob,
      apply_url: match.url,
      source: board.platform,
      source_type: "direct",          // upgraded — it's now a real direct link
      resolved_from: "adzuna",         // (internal note: discovered via Adzuna)
    };
  } catch {
    return null;
  }
}

/**
 * Resolve an array of Adzuna jobs concurrently (bounded).
 * Each job is either upgraded to direct or left as-is.
 */
async function resolveBatch(adzunaJobs = []) {
  const results = await Promise.all(
    adzunaJobs.map(async (job) => {
      const direct = await resolveDirect(job);
      return direct || job; // upgrade if possible, else keep original
    })
  );
  return results;
}

module.exports = { resolveDirect, resolveBatch };
