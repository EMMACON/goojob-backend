const { COUNTRY_BY_CODE, US_STATES, CA_PROVINCES } = require("./places");

const REMOTE_ONLY = /^(remote|remotely|wfh|work from home|working from home|anywhere|worldwide|distributed|home[ -]?based|fully remote)$/i;

function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    const key = body.toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos" || key === "#39") return "'";
    if (key === "nbsp" || key === "#160") return " ";
    if (key[0] === "#") {
      const cp = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp < 0x110000) {
        try { return String.fromCodePoint(cp); } catch { return " "; }
      }
    }
    return " ";
  });
}

// Collapse HTML, nbsp runs, and sentences that were glued together when
// tags were stripped ("operations.By").
function cleanDescription(raw, maxLen = 600) {
  let s = String(raw || "");
  if (!s) return "";
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, " ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|section|article|td|th)>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, " ");
  // Space only after a real sentence boundary, not "U.S."
  s = s.replace(/([a-z])([.!?])([A-Z])/g, "$1$2 $3");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

function normalizeEmploymentType(raw, title = "") {
  const s = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const titleIntern = /\bintern(ship)?s?\b/i.test(title || "");
  if (titleIntern || /intern|praktikum/.test(s)) return "Internship";
  if (/part|teilzeit/.test(s)) return "Part-time";
  if (/full|vollzeit/.test(s) || s === "permanent" || s === "employee") return "Full-time";
  if (/contract|freelance|temporary|^temp$|fixed_term|casual|befristet/.test(s)) return "Contract";
  return "";
}

function titleSaysRemote(title) {
  const t = String(title || "").trim();
  if (!t) return false;
  if (/\b(work from home|wfh)\b/i.test(t)) return true;
  if (/^remote sensing\b/i.test(t)) return false;
  if (/^remote\b/i.test(t)) return true;
  if (/[-–—(|]\s*remote\s*\)?$/i.test(t)) return true;
  return false;
}

function isStateCode(code) {
  return US_STATES.has(code) || CA_PROVINCES.has(code);
}

// "Paris, fr" → "Paris, France". "., fr" → "France". "Denver, CO" stays a
// state. A location that is only "Remote" becomes empty so clients that
// append their own " · Remote" don't render "Remote · Remote".
function normalizeLocation(raw) {
  let s = String(raw || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!s || /^unknown$/i.test(s) || /^n\/?a$/i.test(s)) {
    return { location: "", remote: false };
  }

  const parts = s.split(/,|·|\||\/|•/).map((p) => p.trim()).filter(Boolean);
  let remote = false;
  const cleaned = [];

  for (const part of parts) {
    if (REMOTE_ONLY.test(part)) {
      remote = true;
      continue;
    }
    if (/^[.\-_/]+$/.test(part)) continue;

    if (/^[A-Za-z]{2}$/.test(part)) {
      const lower = part.toLowerCase();
      const upper = part.toUpperCase();
      const state = isStateCode(lower);
      // Lever-style "Denver, CO": an uppercase state code stays a state.
      if (part === upper && state) {
        cleaned.push(upper);
        continue;
      }
      const country = COUNTRY_BY_CODE[lower];
      // SmartRecruiters-style "Paris, fr": lowercase (or an uppercase code
      // that is not a state) is a country.
      if (country && !(part === upper && state)) {
        cleaned.push(country);
        continue;
      }
      cleaned.push(upper);
      continue;
    }

    if (/^(usa|u\.s\.a\.|u\.s\.)$/i.test(part)) {
      cleaned.push("United States");
      continue;
    }
    if (/^(uk|u\.k\.)$/i.test(part)) {
      cleaned.push("United Kingdom");
      continue;
    }
    if (/^uae$/i.test(part)) {
      cleaned.push("United Arab Emirates");
      continue;
    }

    cleaned.push(part);
  }

  const unique = [];
  for (const part of cleaned) {
    if (unique.length && unique[unique.length - 1].toLowerCase() === part.toLowerCase()) continue;
    unique.push(part);
  }

  return { location: unique.join(", "), remote };
}

function normalizeJob(job) {
  if (!job || typeof job !== "object") return job;
  const loc = normalizeLocation(job.location);
  const remote = job.remote === true || job.remote === "true" || loc.remote || titleSaysRemote(job.title);
  return {
    ...job,
    location: loc.location,
    remote: Boolean(remote),
    type: normalizeEmploymentType(job.type, job.title),
    description: cleanDescription(job.description),
  };
}

module.exports = {
  cleanDescription,
  normalizeEmploymentType,
  normalizeLocation,
  normalizeJob,
  titleSaysRemote,
};
