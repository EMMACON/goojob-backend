const axios = require("axios");
const { upsertJobs } = require("../services/db");

// ─────────────────────────────────────────────────────────────
// MANUAL SHEET CRAWLER (Google Sheets)
//
// Lets you hand-add curated jobs by simply typing them into a
// Google Sheet. The crawler reads the published sheet on every
// scheduled run and upserts the rows as normal jobs.
//
// SETUP (one time):
//   1. Create a Google Sheet with these columns in row 1 (exact names):
//        title | company | location | remote | type | description | apply_url | posted_at
//   2. File → Share → Publish to web → choose "Comma-separated values (.csv)"
//   3. Copy the published URL and set it as env var MANUAL_SHEET_CSV_URL
//
// Then just type rows into the sheet — they appear on the site on
// the next crawl. Delete a row and it stops being refreshed (it will
// age out via the 45-day freshness filter).
//
// NOTE: apply_url must be the DIRECT company job link — that's the
// whole point of Goojob, so rows without a valid URL are skipped.
// ─────────────────────────────────────────────────────────────

const SHEET_URL = process.env.MANUAL_SHEET_CSV_URL;
const UA = { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)" };

function isConfigured() {
  return Boolean(SHEET_URL);
}

// Minimal CSV parser that handles quoted fields containing commas
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function truthy(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1" || s === "remote";
}

// Build a stable id from the URL so re-crawling updates rather than duplicates
function idFromUrl(url) {
  return "manual_" + String(url).replace(/[^a-zA-Z0-9]/g, "").slice(-48);
}

async function runManualSheetCrawler({ onProgress } = {}) {
  if (!isConfigured()) {
    console.log("[MANUAL SHEET] MANUAL_SHEET_CSV_URL not set — skipping.");
    return { totalJobs: 0, skipped: true };
  }

  try {
    const { data } = await axios.get(SHEET_URL, { timeout: 15000, headers: UA });
    const rows = parseCSV(String(data));
    if (rows.length < 2) {
      console.log("[MANUAL SHEET] No data rows found.");
      return { totalJobs: 0 };
    }

    // Map header names (case/space insensitive) to column indexes
    const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, "_"));
    const col = (name) => header.indexOf(name);

    const iTitle = col("title");
    const iCompany = col("company");
    const iLocation = col("location");
    const iRemote = col("remote");
    const iType = col("type");
    const iDesc = col("description");
    const iUrl = col("apply_url");
    const iPosted = col("posted_at");

    if (iTitle === -1 || iCompany === -1 || iUrl === -1) {
      console.error("[MANUAL SHEET] Missing required columns: title, company, apply_url");
      return { totalJobs: 0, error: "missing required columns" };
    }

    const jobs = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const title = (row[iTitle] || "").trim();
      const company = (row[iCompany] || "").trim();
      const applyUrl = (row[iUrl] || "").trim();

      // Skip incomplete rows and anything without a real http link
      if (!title || !company || !/^https?:\/\//i.test(applyUrl)) continue;

      const postedRaw = iPosted !== -1 ? (row[iPosted] || "").trim() : "";
      let postedAt = new Date().toISOString();
      if (postedRaw) {
        const d = new Date(postedRaw);
        if (!isNaN(d.getTime())) postedAt = d.toISOString();
      }

      jobs.push({
        external_id: idFromUrl(applyUrl),
        title,
        company,
        location: iLocation !== -1 ? (row[iLocation] || "").trim() : "",
        remote: iRemote !== -1 ? truthy(row[iRemote]) : /remote/i.test(title),
        type: iType !== -1 ? (row[iType] || "").trim() : "",
        description: iDesc !== -1 ? (row[iDesc] || "").trim().slice(0, 600) : "",
        apply_url: applyUrl,
        source: "manual",
        posted_at: postedAt,
      });
    }

    if (jobs.length) {
      await upsertJobs(jobs);
    }

    if (onProgress) onProgress({ source: "manual", totalJobs: jobs.length });
    console.log(`[MANUAL SHEET] Done — ${jobs.length} jobs from sheet`);
    return { totalJobs: jobs.length };
  } catch (err) {
    console.error("[MANUAL SHEET]", err.message);
    return { totalJobs: 0, error: err.message };
  }
}

module.exports = { runManualSheetCrawler, isConfigured };
