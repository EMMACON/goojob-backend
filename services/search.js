const { fold, lookupPlace, matchesPlace, CITY_PHRASES, citiesInCountry } = require("./places");
const { normalizeJob, normalizeEmploymentType } = require("./normalize");

// Equivalence groups. These are whole-word variants, not prefixes.
// "accountant" matches "accounting", and does not match "account".
const EQUIV_GROUPS = [
  ["accountant", "accountants", "accounting"],
  ["engineer", "engineers", "engineering"],
  ["developer", "developers", "development"],
  ["designer", "designers", "design"],
  ["manager", "managers", "management"],
  ["nurse", "nurses", "nursing"],
  ["teacher", "teachers", "teaching"],
  ["marketer", "marketers", "marketing"],
  ["intern", "interns", "internship", "internships"],
  ["analyst", "analysts"],
  ["writer", "writers", "writing"],
  ["editor", "editors", "editing"],
  ["recruiter", "recruiters", "recruiting"],
  ["consultant", "consultants", "consulting"],
  ["administrator", "administrators", "administration"],
  ["technician", "technicians"],
  ["scientist", "scientists"],
  ["lawyer", "lawyers", "attorney", "attorneys"],
  ["physician", "physicians", "doctor", "doctors"],
];

const EQUIV_MAP = new Map();
for (const group of EQUIV_GROUPS) {
  for (const word of group) EQUIV_MAP.set(word, group);
}

const REMOTE_WORDS = new Set(["remote", "remotely", "wfh", "anywhere"]);
const ONSITE_WORDS = new Set(["onsite"]);
const INTERN_WORDS = new Set(["intern", "interns", "internship", "internships"]);
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "of", "to", "in", "at", "on",
  "near", "job", "jobs", "role", "roles", "opening", "openings", "position", "positions",
]);

const INTENT_PHRASES = [
  ["work from home", "remote"],
  ["working from home", "remote"],
  ["in office", "onsite"],
  ["in-office", "onsite"],
  ["on site", "onsite"],
  ["on-site", "onsite"],
];

const POOL_LIMIT = 400;
const MAX_JOB_AGE_DAYS = 45;

function tokens(value) {
  return fold(value).split(/[^a-z0-9+#]+/).filter((w) => w.length > 1);
}

function sameWord(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ga = EQUIV_MAP.get(a);
  const gb = EQUIV_MAP.get(b);
  if (ga && ga === gb) return true;
  if (a.length > 3 && b.length > 3) {
    if (a + "s" === b || b + "s" === a) return true;
    if (a.endsWith("s") && a.slice(0, -1) === b) return true;
    if (b.endsWith("s") && b.slice(0, -1) === a) return true;
  }
  return false;
}

// Forms sent to SQL. Shorter stems are left out so "designer" does not
// ILIKE '%design%' and "accountant" does not ILIKE '%account%'.
function sqlForms(word) {
  const group = EQUIV_MAP.get(word) || [word];
  const forms = group.filter((form) => form.length >= word.length - 1);
  return forms.length ? forms : [word];
}

function sqlTerm(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+# ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
}

function parseSearchQuery({ q, query, location = "", type = "", remote } = {}) {
  let remoteFilter;
  if (remote === true || remote === "true") remoteFilter = true;
  else if (remote === false || remote === "false") remoteFilter = false;

  let typeFilter = normalizeEmploymentType(type) || "";
  let hybrid = false;
  let loc = String(location || "").trim();

  let text = fold(q ?? query ?? "");

  for (const [phrase, kind] of INTENT_PHRASES) {
    if (text.includes(phrase)) {
      text = text.replaceAll(phrase, " ");
      if (kind === "remote" && remoteFilter === undefined) remoteFilter = true;
      if (kind === "onsite" && remoteFilter === undefined) remoteFilter = false;
    }
  }

  // Pull city phrases out of the text even when an explicit location
  // param is already set, so the city is not required as a title keyword.
  for (let guard = 0; guard < 5; guard += 1) {
    const padded = ` ${text} `;
    const phrase = CITY_PHRASES.find((candidate) => padded.includes(` ${candidate} `));
    if (!phrase) break;
    text = padded.replace(` ${phrase} `, " ").replace(/\s+/g, " ").trim();
    if (!loc) {
      const place = lookupPlace(phrase);
      if (place) loc = place.label;
    }
  }

  const rawTokens = text.split(/[^a-z0-9+#]+/).filter(Boolean);
  const keywords = [];
  for (const tok of rawTokens) {
    if (REMOTE_WORDS.has(tok)) {
      if (remoteFilter === undefined) remoteFilter = true;
      continue;
    }
    if (ONSITE_WORDS.has(tok) || (tok === "office" && rawTokens.length === 1)) {
      if (remoteFilter === undefined) remoteFilter = false;
      continue;
    }
    if (tok === "hybrid") {
      hybrid = true;
      continue;
    }
    if (INTERN_WORDS.has(tok)) {
      if (!typeFilter) typeFilter = "Internship";
      continue;
    }
    const place = lookupPlace(tok);
    if (place) {
      if (!loc) loc = place.label;
      continue;
    }
    if (STOPWORDS.has(tok)) continue;
    keywords.push(tok);
  }

  return {
    keywords,
    location: loc,
    remote: remoteFilter,
    type: typeFilter,
    hybrid,
  };
}

function orGroup(clauses) {
  return `or(${clauses.join(",")})`;
}

function keywordGroup(word) {
  const clauses = [];
  for (const form of sqlForms(word)) {
    const term = sqlTerm(form).replace(/ /g, "");
    if (term.length < 2) continue;
    clauses.push(`title.ilike.*${term}*`);
    clauses.push(`company.ilike.*${term}*`);
  }
  return clauses.length ? orGroup(clauses) : "";
}

// PostgREST filter. Keyword groups are AND-ed. Description is not scanned:
// the scorer ignores description-only hits, and ILIKE on description was a
// sequential scan that made searches slow.
function buildJobQuery(parsed, { limit = POOL_LIMIT } = {}) {
  const params = new URLSearchParams();
  params.set("select", "id,external_id,title,company,location,remote,type,description,apply_url,company_logo,logo_color,featured,source,posted_at,created_at");
  params.set("order", "posted_at.desc");
  params.set("limit", String(limit));

  const groups = [];
  for (const word of parsed.keywords || []) {
    const group = keywordGroup(word);
    if (group) groups.push(group);
  }

  if (parsed.remote === true) {
    groups.push(orGroup([
      "remote.eq.true",
      "title.ilike.*remote*",
      "location.ilike.*remote*",
    ]));
  }

  // Stored type values are inconsistent ("Internship", "intern", empty),
  // and many internships only say so in the title. Keep them in the
  // candidate pool instead of letting newer full-time roles crowd them out.
  if (parsed.type === "Internship") {
    groups.push(orGroup(["title.ilike.*intern*", "type.ilike.*intern*"]));
  }

  const place = lookupPlace(parsed.location);
  if (place?.kind === "country") {
    const clauses = [];
    const name = sqlTerm(place.name);
    if (name.length >= 4) clauses.push(`location.ilike.*${name}*`);
    for (const city of citiesInCountry(place.name)) {
      const cityTerm = sqlTerm(city);
      if (cityTerm.length >= 5) clauses.push(`location.ilike.*${cityTerm}*`);
    }
    clauses.push("location.ilike.*worldwide*");
    clauses.push("location.ilike.*anywhere*");
    if (clauses.length) groups.push(orGroup([...new Set(clauses)]));
  }

  if (groups.length === 1) {
    const inner = groups[0].replace(/^or\(/, "").replace(/\)$/, "");
    params.set("or", `(${inner})`);
  } else if (groups.length > 1) {
    params.set("and", `(${groups.join(",")})`);
  }

  if (parsed.remote === false) params.set("remote", "eq.false");

  const since = new Date(Date.now() - MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  params.set("posted_at", `gte.${since}`);

  if (place?.kind === "city") {
    const city = sqlTerm(place.city);
    if (city.length >= 4) params.set("location", `ilike.*${city}*`);
  } else if (parsed.location && !place) {
    const loc = sqlTerm(parsed.location);
    if (loc.length >= 4) params.set("location", `ilike.*${loc}*`);
  }

  return params;
}

function isInternship(job) {
  if (job.type === "Internship") return true;
  return /\bintern(ship)?s?\b/i.test(job.title || "");
}

function scoreJob(job, parsed) {
  const keywords = parsed.keywords || [];
  if (!keywords.length) return 1;

  const titleTokens = tokens(job.title);
  const companyTokens = tokens(job.company);
  let titleHits = 0;
  let companyHits = 0;

  for (const word of keywords) {
    if (titleTokens.some((token) => sameWord(word, token))) titleHits += 1;
    else if (companyTokens.some((token) => sameWord(word, token))) companyHits += 1;
  }

  // Every keyword has to land on the title or the company. A description
  // mention is not enough — that is what let unrelated roles through.
  if (titleHits + companyHits < keywords.length) return 0;

  let score = titleHits * 10 + companyHits * 6;
  if (titleHits === keywords.length) score += 5;

  const phrase = keywords.join(" ");
  if (phrase && fold(job.title).includes(phrase)) score += 4;

  // Internships are a strong negative signal unless the query asked for them.
  if (parsed.type !== "Internship" && isInternship(job)) score -= 8;

  return score;
}

function passesFilters(job, parsed) {
  if (parsed.remote === true && job.remote !== true) return false;
  if (parsed.remote === false && job.remote === true) return false;
  if (parsed.type && job.type !== parsed.type) return false;
  if (parsed.hybrid) {
    const blob = `${job.title} ${job.location}`;
    if (!/\bhybrid\b/i.test(blob)) return false;
  }
  if (parsed.location && !matchesPlace(job.location, parsed.location)) return false;
  return true;
}

function titleKey(title) {
  return fold(title).replace(/[^a-z0-9+#]+/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeJobs(jobs) {
  const groups = new Map();
  const order = [];
  for (const job of jobs) {
    const key = `${fold(job.company)}|${titleKey(job.title)}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(job);
  }

  return order.map((key) => {
    const group = groups.get(key);
    const primary = group[0];
    const locations = [];
    for (const job of group) {
      if (job.location && !locations.includes(job.location)) locations.push(job.location);
    }
    let location = locations[0] || "";
    if (locations.length === 2) location = locations.join(" · ");
    else if (locations.length > 2) {
      location = `${locations[0]} · ${locations[1]} · +${locations.length - 2} more`;
    }
    return {
      ...primary,
      location,
      locations,
      location_count: locations.length,
    };
  });
}

function diversifyJobs(jobs, { limit = 40, perCompany = 3 } = {}) {
  const counts = new Map();
  const out = [];
  for (const job of jobs) {
    const company = fold(job.company) || "unknown";
    const seen = counts.get(company) || 0;
    if (seen >= perCompany) continue;
    counts.set(company, seen + 1);
    out.push(job);
    if (out.length >= limit) break;
  }
  return out;
}

function rankJobs(rawJobs, queryInput, { diversify = false, perCompany = 3 } = {}) {
  const parsed = Array.isArray(queryInput?.keywords)
    ? queryInput
    : parseSearchQuery(queryInput || {});

  const ranked = [];
  for (const raw of rawJobs || []) {
    const job = normalizeJob(raw);
    if (!passesFilters(job, parsed)) continue;
    const score = scoreJob(job, parsed);
    if (parsed.keywords.length && score <= 0) continue;
    ranked.push({ job, score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.job.posted_at || 0) - new Date(a.job.posted_at || 0);
  });

  let jobs = dedupeJobs(ranked.map((row) => row.job));
  if (diversify || parsed.keywords.length === 0) {
    jobs = diversifyJobs(jobs, { limit: jobs.length, perCompany });
  }
  return { jobs, total: jobs.length, parsed };
}

function prepareRecentJobs(rawJobs, { limit = 40, perCompany = 3 } = {}) {
  const fresh = (rawJobs || []).map((job) => normalizeJob(job));
  fresh.sort((a, b) => new Date(b.posted_at || 0) - new Date(a.posted_at || 0));
  const deduped = dedupeJobs(fresh);
  const jobs = diversifyJobs(deduped, { limit, perCompany });
  return { jobs, total: jobs.length };
}

function paginate(jobs, page, limit) {
  const safePage = Math.max(1, Math.min(Number(page) || 1, 500));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 50));
  const start = (safePage - 1) * safeLimit;
  return {
    jobs: jobs.slice(start, start + safeLimit),
    total: jobs.length,
    page: safePage,
    limit: safeLimit,
  };
}

function isFresh(job, now = Date.now()) {
  if (!job?.posted_at) return false;
  const posted = new Date(job.posted_at).getTime();
  if (Number.isNaN(posted)) return false;
  const age = now - posted;
  if (age < 0) return true;
  return age <= MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function hasSearchIntent(parsed) {
  return Boolean(
    parsed.keywords.length ||
    parsed.location ||
    parsed.type ||
    parsed.hybrid ||
    parsed.remote !== undefined
  );
}

module.exports = {
  EQUIV_MAP,
  POOL_LIMIT,
  MAX_JOB_AGE_DAYS,
  tokens,
  sameWord,
  sqlForms,
  parseSearchQuery,
  buildJobQuery,
  scoreJob,
  passesFilters,
  dedupeJobs,
  diversifyJobs,
  rankJobs,
  prepareRecentJobs,
  paginate,
  isFresh,
  hasSearchIntent,
  isInternship,
};
