#!/usr/bin/env node
// Reproducible before/after for the 16 Nov 2026 search failures.
// The "before" scorer is the previous prefix stemmer (accountant → account,
// then a startsWith match). The "after" scorer is what /api/jobs/search uses.
//
//   node scripts/search-quality-demo.js

const { rankJobs, parseSearchQuery, prepareRecentJobs } = require("../services/search");
const { normalizeJob } = require("../services/normalize");

const NOW = "2026-11-16T12:00:00.000Z";

function job(partial) {
  return {
    company: "Acme",
    location: "London",
    remote: false,
    type: "Full-time",
    description: "",
    posted_at: NOW,
    ...partial,
  };
}

function legacyStem(word) {
  return String(word).toLowerCase().replace(/(ing|ers|er|ed|es|ation|ment|ist|ant|ent|s)$/i, "");
}

function legacyScore(row, words) {
  const title = (row.title || "").toLowerCase();
  const titleStems = title.split(/[^a-z0-9]+/).map(legacyStem).filter(Boolean);
  let score = 0;
  let titleHits = 0;
  for (const word of words) {
    const stem = legacyStem(word);
    const inTitle = title.includes(word) || (
      stem.length >= 3 && titleStems.some((token) => token === stem || token.startsWith(stem) || stem.startsWith(token))
    );
    if (inTitle) {
      score += 3;
      titleHits += 1;
    }
  }
  if (!titleHits) return 0;
  return score;
}

function legacyRank(rows, query) {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  return rows
    .map((row) => ({ row, score: legacyScore(row, words) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.row.posted_at) - new Date(a.row.posted_at))
    .map((item) => item.row.title);
}

function show(name, query, rows, extra) {
  const before = legacyRank(rows, query);
  const after = rankJobs(rows, { q: query, ...extra });
  console.log(`\n=== ${name}`);
  console.log("query:", JSON.stringify(query), "parsed:", JSON.stringify(after.parsed));
  console.log("before:", before.slice(0, 6).join(" | ") || "(none)");
  console.log("after: ", after.jobs.slice(0, 6).map((item) => {
    const where = item.location ? ` @ ${item.location}` : "";
    const kind = item.type ? ` [${item.type}]` : "";
    const flag = item.remote ? " remote" : "";
    return `${item.title}${kind}${flag}${where}`;
  }).join(" | ") || "(none)");
}

const accountantRows = [
  job({ title: "Strategic Account Manager", company: "Whereby", location: "Remote", remote: true }),
  job({ title: "Account Executive", company: "Whereby", location: "Remote", remote: true }),
  job({ title: "Account Executive, Commercial", company: "Outreach", location: "Remote", remote: true }),
  job({ title: "Lead Accountant, France & Accounting Integration", company: "Feverup", location: "Paris, fr" }),
  job({ title: "Accounting Intern", company: "Accor", location: "Amsterdam, nl", posted_at: "2026-11-16T18:00:00.000Z" }),
  job({ title: "Staff Accountant", company: "Local Books", location: "Accra, Ghana", posted_at: "2026-11-02T00:00:00.000Z" }),
  job({ title: "Accountant", company: "Accra Ledger", location: "Accra, GH" }),
];

show("accountant", "accountant", accountantRows);
show("accountant Accra", "accountant Accra", accountantRows);

const marketingRows = [
  job({ title: "Manager-In-Development (Marketing)", company: "Accor", location: "Krong Siem Reap, kh" }),
  job({ title: "Sales and Marketing Director", company: "Accor", location: "Tashkent, uz" }),
  job({ title: "Data Scientist Marketing", company: "bunq", location: "Amsterdam, Netherlands", type: "fulltime_permanent" }),
  job({ title: "Associate Manager, Offline Marketing", company: "Ro", location: "Remote", remote: true }),
  job({ title: "Marketing Lead", company: "Remote First", location: "Berlin, de", remote: true }),
];
show("remote marketing", "remote marketing", marketingRows);

const engineerRows = [
  job({ title: "Software Engineer, Intern - Connectivity Platform and Product", company: "Palantir", location: "Denver, CO", type: "Internship", posted_at: "2026-11-16T18:00:00.000Z" }),
  job({ title: "Software Engineer, Internship - Sovereign AI Systems", company: "Palantir", location: "London, United Kingdom", type: "Internship", posted_at: "2026-11-16T17:00:00.000Z" }),
  job({ title: "Software Engineer, Internship - Sovereign AI Systems", company: "Palantir", location: "New York, NY", type: "Full-time", posted_at: "2026-11-16T16:00:00.000Z" }),
  job({ title: "Backend Software Engineer - Data Connectors", company: "Palantir", location: "New York, NY", posted_at: "2026-11-10T00:00:00.000Z" }),
  job({ title: "Staff Software Engineer (Backend)", company: "Outreach", location: "Remote", remote: true, posted_at: "2026-11-12T00:00:00.000Z" }),
];
show("software engineer", "software engineer", engineerRows);

const careRows = [
  job({ title: "Family Medicine Nurse Practitioner", company: "One Medical", location: "Seattle, WA" }),
  job({ title: "Nurse Practitioner", company: "Clover Health", location: "New Jersey" }),
  job({ title: "High School Math Teacher", company: "Example Schools", location: "Accra, Ghana" }),
  job({ title: "Teaching Assistant", company: "Khan Academy", location: "Remote", remote: true }),
  job({ title: "Account Executive", company: "Whereby", location: "Remote", remote: true }),
];
show("nurse", "nurse", careRows);
show("teacher", "teacher", careRows);

console.log("\n=== normalization");
for (const sample of ["Paris, fr", "., fr", "nl", "Denver, CO", "Remote", "fulltime_permanent"]) {
  const normalized = normalizeJob(job({
    location: sample.startsWith("full") ? "Paris, fr" : sample,
    type: sample.startsWith("full") ? sample : "Full-time",
    remote: sample === "Remote",
  }));
  console.log(
    JSON.stringify(sample),
    "→",
    `location=${JSON.stringify(normalized.location)}`,
    `remote=${normalized.remote}`,
    `type=${normalized.type}`,
  );
}

const recentInput = [];
for (let i = 0; i < 34; i += 1) {
  recentInput.push(job({ title: `Hotel role ${i}`, company: "Accor", location: "Paris, fr", posted_at: new Date(Date.parse(NOW) - i * 1000).toISOString() }));
}
for (const company of ["bunq", "Outreach", "Palantir", "Ro", "Skroutz"]) {
  recentInput.push(job({ title: "Analyst", company, posted_at: "2026-11-15T00:00:00.000Z" }));
}
const recent = prepareRecentJobs(recentInput, { limit: 40, perCompany: 3 });
const accor = recent.jobs.filter((item) => item.company === "Accor").length;
console.log(`\n=== latest feed\nbefore: 34 of 40 from Accor\nafter: ${accor} of ${recent.jobs.length} from Accor (cap 3)`);

const parsed = parseSearchQuery({ q: "remote marketing" });
console.log("\n=== params recognized on 'remote marketing'");
console.log(parsed);
