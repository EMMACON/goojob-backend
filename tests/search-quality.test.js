const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeJob, normalizeLocation, cleanDescription } = require("../services/normalize");
const {
  parseSearchQuery,
  buildJobQuery,
  rankJobs,
  prepareRecentJobs,
  sqlForms,
  isFresh,
} = require("../services/search");

const NOW = "2026-11-16T12:00:00.000Z";

function job(partial) {
  return {
    title: "Role",
    company: "Acme",
    location: "London, United Kingdom",
    remote: false,
    type: "Full-time",
    description: "",
    posted_at: NOW,
    apply_url: "https://example.com/jobs/1",
    source: "lever",
    ...partial,
  };
}

function titles(result) {
  return result.jobs.map((item) => item.title);
}

function homepageLine(item) {
  const company = item.company;
  const place = item.location ? ` · ${item.location}` : "";
  const remote = item.remote ? " · Remote" : "";
  return `${company}${place}${remote}`;
}

test("accountant does not match account-executive titles", () => {
  const result = rankJobs([
    job({ title: "Strategic Account Manager", company: "Whereby", location: "Remote", remote: true }),
    job({ title: "Account Executive", company: "Whereby", location: "Remote", remote: true }),
    job({ title: "Account Executive, Commercial", company: "Outreach", location: "Remote", remote: true }),
    job({ title: "Mid-Market Account Executive", company: "Olo", location: "Remote", remote: true }),
    job({ title: "Lead Accountant, France & Accounting Integration", company: "Feverup", location: "Paris, fr" }),
    job({ title: "Accounting Intern", company: "Accor", location: "Amsterdam, nl", posted_at: "2026-11-16T15:00:00.000Z" }),
    job({ title: "Staff Accountant", company: "Local Books", location: "Accra, Ghana", posted_at: "2026-11-01T00:00:00.000Z" }),
  ], { q: "accountant" });

  assert.deepEqual(titles(result), [
    "Lead Accountant, France & Accounting Integration",
    "Staff Accountant",
    "Accounting Intern",
  ]);
  assert.equal(result.jobs[0].location, "Paris, France");
  assert.equal(result.jobs[2].type, "Internship");
  assert.equal(result.jobs[2].location, "Amsterdam, Netherlands");
  assert.ok(result.jobs[0].type !== "Internship");
});

test("accountant Accra keeps only Accra roles", () => {
  const parsed = parseSearchQuery({ q: "accountant Accra" });
  assert.deepEqual(parsed.keywords, ["accountant"]);
  assert.equal(parsed.location, "Accra");

  const params = buildJobQuery(parsed);
  const filter = `${params.get("or") || ""} ${params.get("and") || ""}`;
  assert.equal(params.get("location"), "ilike.*accra*");
  assert.ok(filter.includes("ilike.*accountant*"));
  assert.ok(filter.includes("ilike.*accounting*"));
  assert.ok(!filter.split(",").some((clause) => clause.includes("ilike.*account*")));

  const result = rankJobs([
    job({ title: "Staff Accountant", company: "Local Books", location: "Accra, GH" }),
    job({ title: "Lead Accountant", company: "Feverup", location: "Accra, Ghana" }),
    job({ title: "Accounting Intern", company: "Accor", location: "Amsterdam, nl" }),
    job({ title: "Account Executive", company: "Whereby", location: "Accra, Ghana" }),
    job({ title: "Accountant", company: "Paris Firm", location: "Paris, fr" }),
  ], { q: "accountant in Accra" });

  assert.deepEqual(titles(result).sort(), ["Lead Accountant", "Staff Accountant"]);
  assert.ok(result.jobs.every((item) => /accra/i.test(item.location)));
});

test("explicit location param is a filter and is documented by the parser", () => {
  const parsed = parseSearchQuery({ q: "accountant", location: "Accra" });
  assert.equal(parsed.location, "Accra");
  assert.deepEqual(parsed.keywords, ["accountant"]);

  const override = parseSearchQuery({ q: "accountant Accra", location: "Paris" });
  assert.equal(override.location, "Paris");
  assert.deepEqual(override.keywords, ["accountant"]);
});

test("remote marketing drops on-site jobs and does not search for the word remote", () => {
  const parsed = parseSearchQuery({ q: "remote marketing" });
  assert.equal(parsed.remote, true);
  assert.deepEqual(parsed.keywords, ["marketing"]);

  const params = buildJobQuery(parsed);
  const filter = params.get("and") || "";
  assert.match(filter, /title\.ilike\.\*marketing\*/);
  assert.match(filter, /remote\.eq\.true/);
  assert.equal((filter.match(/marketing/g) || []).length > 0, true);

  const result = rankJobs([
    job({ title: "Manager-In-Development (Marketing)", company: "Accor", location: "Krong Siem Reap, kh" }),
    job({ title: "Sales and Marketing Director", company: "Accor", location: "Tashkent, uz" }),
    job({ title: "Data Scientist Marketing", company: "bunq", location: "Amsterdam, Netherlands", type: "fulltime_permanent" }),
    job({ title: "Associate Manager, Offline Marketing", company: "Ro", location: "Remote", remote: true }),
    job({ title: "Marketing Lead", company: "Remote First", location: "London, United Kingdom", remote: true, type: "Full-time" }),
    job({ title: "Remote Account Executive", company: "Whereby", location: "Remote", remote: true }),
  ], { q: "remote marketing" });

  assert.deepEqual(titles(result).sort(), [
    "Associate Manager, Offline Marketing",
    "Marketing Lead",
  ]);
  assert.ok(result.jobs.every((item) => item.remote === true));
  assert.equal(result.jobs.some((item) => item.company === "bunq"), false);
  assert.equal(result.jobs.some((item) => item.company === "Accor"), false);
});

test("work from home and wfh are remote filters", () => {
  assert.equal(parseSearchQuery({ q: "work from home nurse" }).remote, true);
  assert.deepEqual(parseSearchQuery({ q: "wfh nurse" }).keywords, ["nurse"]);
  assert.equal(parseSearchQuery({ q: "onsite designer" }).remote, false);
  assert.equal(parseSearchQuery({ q: "hybrid designer" }).hybrid, true);
  const intern = parseSearchQuery({ q: "software engineer intern" });
  assert.equal(intern.type, "Internship");
  assert.deepEqual(intern.keywords, ["software", "engineer"]);
  assert.match(buildJobQuery(intern).get("and"), /intern/);
  assert.equal(parseSearchQuery({ q: "remote", remote: "false" }).remote, false);

  const france = rankJobs([
    job({ title: "Lead Accountant", location: "Paris, fr" }),
    job({ title: "Staff Accountant", location: "Amsterdam, nl" }),
  ], { q: "accountant France" });
  assert.deepEqual(titles(france), ["Lead Accountant"]);
  assert.equal(france.jobs[0].location, "Paris, France");
});

test("software engineer ranks full-time roles ahead of internships and collapses locations", () => {
  const result = rankJobs([
    job({
      title: "Software Engineer, Intern - Connectivity Platform and Product",
      company: "Palantir",
      location: "Denver, CO",
      type: "Internship",
      posted_at: "2026-11-16T18:00:00.000Z",
    }),
    job({
      title: "Software Engineer, Internship - Sovereign AI Systems",
      company: "Palantir",
      location: "London, United Kingdom",
      type: "Internship",
      posted_at: "2026-11-16T17:00:00.000Z",
    }),
    job({
      title: "Software Engineer, Internship - Sovereign AI Systems",
      company: "Palantir",
      location: "New York, NY",
      type: "Full-time",
      posted_at: "2026-11-16T16:00:00.000Z",
    }),
    job({
      title: "Backend Software Engineer - Data Connectors",
      company: "Palantir",
      location: "New York, NY",
      posted_at: "2026-11-10T12:00:00.000Z",
    }),
    job({
      title: "Staff Software Engineer (Backend)",
      company: "Outreach",
      location: "Remote",
      remote: true,
      posted_at: "2026-11-12T12:00:00.000Z",
    }),
    job({ title: "Engineering Manager", company: "Outreach", location: "Hyderabad" }),
    job({ title: "Product Manager", company: "Gopuff", location: "Miami, FL" }),
  ], { q: "software engineer" });

  assert.deepEqual(titles(result).slice(0, 3), [
    "Staff Software Engineer (Backend)",
    "Backend Software Engineer - Data Connectors",
    "Software Engineer, Intern - Connectivity Platform and Product",
  ]);
  const sovereign = result.jobs.find((item) => item.title.includes("Sovereign AI"));
  assert.equal(sovereign.location_count, 2);
  assert.match(sovereign.location, /London, United Kingdom/);
  assert.match(sovereign.location, /New York, NY/);
  assert.equal(sovereign.type, "Internship");
  assert.ok(!titles(result).includes("Engineering Manager"));
  assert.ok(!titles(result).includes("Product Manager"));
});

test("product manager requires both words", () => {
  const result = rankJobs([
    job({ title: "Senior Product Marketing Manager, Platform", company: "Outreach" }),
    job({ title: "Warehouse Manager", company: "Blueground", location: "Newark, New Jersey, United States" }),
    job({ title: "Housekeeping Manager (m/w/d)", company: "Accor", location: "Munich, de" }),
    job({ title: "Product Manager", company: "Persado", location: "United States" }),
  ], { q: "product manager" });

  assert.deepEqual(titles(result).sort(), [
    "Product Manager",
    "Senior Product Marketing Manager, Platform",
  ]);
  assert.equal(result.jobs.some((item) => item.company === "Accor" || item.company === "Blueground"), false);
});

test("nurse and teacher match the profession, not a shared prefix", () => {
  const nurses = rankJobs([
    job({ title: "Family Medicine Nurse Practitioner", company: "One Medical", location: "Seattle, WA", type: "" }),
    job({ title: "Nurse Practitioner", company: "Clover Health", location: "Central New Jersey" }),
    job({ title: "Nursing Supervisor", company: "Honor", location: "Santa Rosa, CA" }),
    job({ title: "Nursery Assistant", company: "Daycare", location: "Accra, Ghana" }),
    job({ title: "Account Executive", company: "Whereby", location: "Remote", remote: true }),
  ], { q: "nurse" });
  assert.deepEqual(titles(nurses).sort(), [
    "Family Medicine Nurse Practitioner",
    "Nurse Practitioner",
    "Nursing Supervisor",
  ]);

  const teachers = rankJobs([
    job({ title: "High School Math Teacher", company: "Example Schools", location: "Accra, Ghana" }),
    job({ title: "Teaching Assistant", company: "Khan Academy", location: "Remote", remote: true }),
    job({ title: "Software Engineer", company: "Palantir", location: "Denver, CO" }),
  ], { q: "teacher" });
  assert.deepEqual(titles(teachers).sort(), ["High School Math Teacher", "Teaching Assistant"]);
});

test("employment type, country codes, broken locations, and remote labels are normalized", () => {
  assert.equal(normalizeJob(job({ type: "fulltime_permanent" })).type, "Full-time");
  assert.equal(normalizeJob(job({ type: "fulltime_fixed_term" })).type, "Full-time");
  assert.equal(normalizeJob(job({ type: "part_time" })).type, "Part-time");
  assert.equal(normalizeJob(job({ type: "contract" })).type, "Contract");
  assert.equal(normalizeJob(job({ type: "Full-time", title: "Software Engineer, Internship - Warp Speed" })).type, "Internship");
  assert.equal(normalizeJob(job({ type: "Full-time", title: "Internal Communications Manager" })).type, "Full-time");

  assert.deepEqual(normalizeLocation("Paris, fr"), { location: "Paris, France", remote: false });
  assert.deepEqual(normalizeLocation("nl"), { location: "Netherlands", remote: false });
  assert.deepEqual(normalizeLocation("., fr"), { location: "France", remote: false });
  assert.deepEqual(normalizeLocation("Krong Siem Reap, kh"), { location: "Krong Siem Reap, Cambodia", remote: false });
  assert.deepEqual(normalizeLocation("Agadir, ma"), { location: "Agadir, Morocco", remote: false });
  assert.deepEqual(normalizeLocation("Tashkent, uz"), { location: "Tashkent, Uzbekistan", remote: false });
  assert.deepEqual(normalizeLocation("Denver, CO"), { location: "Denver, CO", remote: false });
  assert.deepEqual(normalizeLocation("Boston, MA"), { location: "Boston, MA", remote: false });
  assert.deepEqual(normalizeLocation("Remote"), { location: "", remote: true });

  const remoteJob = normalizeJob(job({ company: "Ro", title: "Manager", location: "Remote", remote: true }));
  assert.equal(homepageLine(remoteJob), "Ro · Remote");
  assert.equal(remoteJob.location, "");

  const twice = normalizeJob(normalizeJob(job({ location: "Paris, fr", type: "fulltime_permanent" })));
  const once = normalizeJob(job({ location: "Paris, fr", type: "fulltime_permanent" }));
  assert.equal(twice.location, once.location);
  assert.equal(twice.type, once.type);
});

test("descriptions lose tag glue and extra whitespace", () => {
  const raw = "<p>A World-Changing Company</p><p>operations.By bringing the right data.</p>&nbsp;&nbsp;  More   text";
  const cleaned = cleanDescription(raw);
  assert.equal(cleaned.includes("<"), false);
  assert.match(cleaned, /operations\. By bringing/);
  assert.equal(cleaned.includes("  "), false);
  assert.equal(cleaned.includes("\u00a0"), false);
  assert.match(cleaned, /A World-Changing Company operations/);
});

test("latest feed caps a single company and collapses duplicate titles", () => {
  const rows = [];
  for (let i = 0; i < 34; i += 1) {
    rows.push(job({
      title: i % 2 === 0 ? "Receptionist" : `Chef ${i}`,
      company: "Accor",
      location: "Paris, fr",
      posted_at: new Date(Date.parse(NOW) - i * 60000).toISOString(),
    }));
  }
  rows.push(job({ title: "Receptionist", company: "Accor", location: "Lyon, fr", posted_at: NOW }));
  for (const company of ["bunq", "Outreach", "Palantir", "Ro", "Skroutz"]) {
    rows.push(job({ title: "Analyst", company, location: "Remote", remote: true, posted_at: "2026-11-15T12:00:00.000Z" }));
  }

  const recent = prepareRecentJobs(rows, { limit: 40, perCompany: 3 });
  const accor = recent.jobs.filter((item) => item.company === "Accor");
  assert.ok(accor.length <= 3);
  assert.ok(accor.length >= 1);
  assert.equal(recent.jobs.filter((item) => item.company !== "Accor").length, 5);
  const receptionist = accor.find((item) => item.title === "Receptionist");
  assert.ok(receptionist.location_count >= 2);
  assert.match(receptionist.location, /France/);
});

test("sql forms do not shorten accountant to account", () => {
  assert.ok(sqlForms("accountant").includes("accounting"));
  assert.ok(!sqlForms("accountant").includes("account"));
  assert.ok(!sqlForms("designer").includes("design"));
  assert.ok(sqlForms("nurse").includes("nursing"));

  const swe = buildJobQuery(parseSearchQuery({ q: "software engineer" }));
  const filter = swe.get("and");
  assert.ok(filter.startsWith("(") && filter.endsWith(")"));
  let depth = 0;
  for (const ch of filter) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    assert.ok(depth >= 0);
  }
  assert.equal(depth, 0);
  assert.match(filter, /software/);
  assert.match(filter, /engineer/);
});

test("ranking a few thousand jobs stays in memory and under a tight budget", () => {
  const rows = Array.from({ length: 3000 }, (_, i) => job({
    title: i % 4 === 0 ? "Staff Accountant" : "Account Executive",
    company: `Company ${i % 40}`,
    location: i % 6 === 0 ? "Accra, Ghana" : "Amsterdam, nl",
    description: "Responsibilities include reporting.By the way this was glued.  Extra   space",
    posted_at: new Date(Date.parse(NOW) - i * 1000).toISOString(),
  }));
  const started = Date.now();
  const result = rankJobs(rows, { q: "accountant Accra" });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, `ranking took ${elapsed}ms`);
  assert.ok(result.jobs.length > 0);
  assert.ok(result.jobs.every((item) => /accountant/i.test(item.title)));
  assert.ok(result.jobs.every((item) => /accra/i.test(item.location)));
  assert.ok(result.total < 3000);
});

test("stale jobs are identifiable", () => {
  assert.equal(isFresh(job({ posted_at: NOW }), Date.parse(NOW)), true);
  assert.equal(isFresh(job({ posted_at: "2026-01-01T00:00:00.000Z" }), Date.parse(NOW)), false);
  assert.equal(isFresh(job({ posted_at: null }), Date.parse(NOW)), false);
});
