const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRobots, groupFor, pathAllowed } = require("../services/robots");
const { diffStaleIds } = require("../services/expiry");
const { workdayPostedAt, mapWorkdayJob, queryHits } = require("../crawlers/workday");
const { mapOracleJob, oraclePostedAt } = require("../crawlers/oracle-cloud");
const { mapBambooJob } = require("../crawlers/bamboohr");
const { parseSitemapXml, parseAccorJob } = require("../crawlers/sitemap-feed");
const { parseSearchQuery, buildJobQuery, rankJobs, isFresh } = require("../services/search");
const { matchesPlace } = require("../services/places");
const { toRow } = require("../services/db");

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

test("smartrecruiters robots disallow the public API for this crawler", () => {
  const text = "User-agent: LinkedInBot\nAllow: /v1/companies/\nUser-agent: *\nDisallow: /\n";
  const rules = groupFor(parseRobots(text), "goojob").rules;
  assert.equal(pathAllowed(rules, "/v1/companies/accor/postings"), false);
  assert.equal(pathAllowed(rules, "/robots.txt"), false);
});

test("greenhouse robots allow the job board API and block embed", () => {
  const text = "User-agent: *\nDisallow: /embed/\n";
  const rules = groupFor(parseRobots(text), "goojob").rules;
  assert.equal(pathAllowed(rules, "/v1/boards/stripe/jobs"), true);
  assert.equal(pathAllowed(rules, "/embed/job_board/js"), false);
});

test("accor robots allow the vacancies sitemap and block job search urls", () => {
  const text = "User-agent: *\nAllow: /\nDisallow: /jobs?*\nDisallow: /admin*\n";
  const rules = groupFor(parseRobots(text), "goojob").rules;
  assert.equal(pathAllowed(rules, "/vacanciessitemap.xml"), true);
  assert.equal(pathAllowed(rules, "/global/en/job/chef-in-accra-ghana-jid-1"), true);
  assert.equal(pathAllowed(rules, "/jobs?q=nurse"), false);
});

test("lever crawl-delay is read from the star group", () => {
  const text = "User-agent: *\nAllow: /\nCrawl-delay: 1\n";
  const group = groupFor(parseRobots(text), "goojob");
  assert.equal(group.crawlDelaySec, 1);
  assert.equal(pathAllowed(group.rules, "/v0/postings/linear"), true);
});

test("workday relative dates stay exact until the 30+ bucket", () => {
  assert.equal(workdayPostedAt("Posted Today", NOW).date_quality, "exact");
  assert.equal(workdayPostedAt("Posted Today", NOW).posted_at, "2026-11-17T12:00:00.000Z");
  assert.equal(workdayPostedAt("Posted Yesterday", NOW).posted_at, "2026-11-16T12:00:00.000Z");
  const three = workdayPostedAt("Posted 3 Days Ago", NOW);
  assert.equal(three.date_quality, "exact");
  assert.equal(three.posted_at, "2026-11-14T12:00:00.000Z");
  const coarse = workdayPostedAt("Posted 30+ Days Ago", NOW);
  assert.equal(coarse.date_quality, "coarse");
  assert.equal(coarse.posted_at, null);
});

test("workday apply url is the employer posting, not the JSON API", () => {
  const job = mapWorkdayJob({
    company: "Cleveland Clinic",
    host: "ccf.wd1.myworkdayjobs.com",
    tenant: "ccf",
    site: "clevelandcliniccareers",
  }, {
    title: "RN - Labor & Delivery",
    externalPath: "/job/Indian-River-Hospital/RN---Labor---Delivery_361346",
    locationsText: "Indian River Hospital",
    postedOn: "Posted Today",
    bulletFields: ["361346"],
  });
  assert.equal(job.external_id, "workday_ccf_clevelandcliniccareers_361346");
  assert.equal(
    job.apply_url,
    "https://ccf.wd1.myworkdayjobs.com/clevelandcliniccareers/job/Indian-River-Hospital/RN---Labor---Delivery_361346"
  );
  assert.equal(job.apply_url.includes("/wday/"), false);
  assert.equal(isFresh({ posted_at: workdayPostedAt("Posted Today", NOW).posted_at }, NOW), true);
});

test("workday uses the job path when the board omits the city", () => {
  const job = mapWorkdayJob({
    company: "FirstRand",
    host: "firstrand.wd3.myworkdayjobs.com",
    tenant: "firstrand",
    site: "frb",
  }, {
    title: "Chief Financial Officer",
    externalPath: "/job/Accra/Chief-Financial-Officer_R54791",
    locationsText: "",
    postedOn: "",
    bulletFields: ["R54791"],
  });
  assert.equal(job.location, "Accra");
  assert.equal(queryHits(job, "Accra"), true);
  assert.equal(queryHits(job, "Ghana"), false);
});

test("place searches ignore workday hits that do not mention the place", () => {
  const istanbul = mapWorkdayJob({
    company: "Diageo", host: "diageo.wd3.myworkdayjobs.com", tenant: "diageo", site: "diageo_careers",
  }, {
    title: "Expenses Accounting Manager",
    externalPath: "/job/Istanbul/Expenses-Accounting-Manager_1",
    locationsText: "Istanbul, Turkey",
    postedOn: "Posted 30+ Days Ago",
    bulletFields: ["1"],
  });
  const accra = { ...istanbul, title: "Clinical Specialist", location: "Accra, Ghana" };
  assert.equal(queryHits(istanbul, "Accra"), false);
  assert.equal(queryHits(accra, "Accra"), true);
  assert.equal(queryHits({ title: "Materials Management Workleader", location: "Main Campus" }, "nurse"), false);
  assert.equal(queryHits({ title: "RN - Labor & Delivery", location: "Indian River" }, "nurse"), true);
});

test("oracle maps a public candidate-experience url and an exact posted date", () => {
  const dated = oraclePostedAt("2026-11-17");
  assert.equal(dated.posted_at, "2026-11-17T00:00:00.000Z");
  const job = mapOracleJob({
    key: "mtn",
    company: "MTN",
    host: "ehle.fa.em2.oraclecloud.com",
    siteNumber: "CX_1",
    sitePath: "CX_1",
  }, {
    Id: "7967",
    Title: "Senior Manager - Business Manager",
    PostedDate: "2026-11-17",
    PrimaryLocation: "Johannesburg, Gauteng, South Africa",
    ShortDescriptionStr: "Lead the team.",
  });
  assert.equal(job.apply_url, "https://ehle.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/7967");
  assert.equal(job.location, "Johannesburg, Gauteng, South Africa");
  assert.equal(job.source, "oracle");
});

test("bamboohr apply url is the company careers page", () => {
  const job = mapBambooJob("africapractice", {
    id: "76",
    jobOpeningName: "Analyst, Insights and Advocacy - Nigeria",
    location: { city: "Lagos", state: "Lagos" },
    employmentStatusLabel: "Full-Time",
  });
  assert.equal(job.apply_url, "https://africapractice.bamboohr.com/careers/76");
  assert.equal(job.company, "Africa Practice");
  assert.equal(job.location, "Lagos, Lagos");
  assert.equal(job.external_id, "bamboohr_africapractice_76");
});

test("accor sitemap urls become direct job pages with a title and place", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://careers.accor.com/global/en/job/head-chef-in-novotel-port-harcourt-port-harcourt-nigeria-jid-107005</loc><lastmod>2026-11-02T19:04:46Z</lastmod></url>
  </urlset>`;
  const [entry] = parseSitemapXml(xml);
  const job = parseAccorJob(entry);
  assert.equal(job.external_id, "sitemap_accor_107005");
  assert.equal(job.company, "Accor");
  assert.match(job.title, /Head Chef/);
  assert.match(job.location, /Port Harcourt/);
  assert.match(job.location, /Nigeria/);
  assert.equal(job.apply_url, entry.loc);
  assert.equal(job.posted_at, "2026-11-02T19:04:46.000Z");
});

test("ghana search asks the database for ghana and accra, not the newest global rows", () => {
  const parsed = parseSearchQuery({ q: "Ghana" });
  assert.equal(parsed.location, "Ghana");
  assert.deepEqual(parsed.keywords, []);
  const params = buildJobQuery(parsed);
  const filter = `${params.get("or") || ""} ${params.get("and") || ""}`;
  assert.match(filter, /ghana/i);
  assert.match(filter, /accra/i);
  assert.match(filter, /kumasi/i);
  assert.match(params.get("posted_at"), /^gte\./);
  assert.equal(matchesPlace("Accra", "Ghana"), true);
  assert.equal(matchesPlace("Lagos, Nigeria", "Ghana"), false);
  assert.equal(matchesPlace("Remote, Worldwide", "Ghana"), true);
});

test("accountant accra is unchanged and still fresh-filtered", () => {
  const params = buildJobQuery(parseSearchQuery({ q: "accountant Accra" }));
  assert.equal(params.get("location"), "ilike.*accra*");
  assert.match(params.get("posted_at"), /^gte\./);
  const result = rankJobs([
    { title: "Staff Accountant", company: "FHI 360", location: "Accra, Ghana", remote: false, type: "Full-time", description: "", apply_url: "https://example.com/a", posted_at: "2026-11-10T00:00:00.000Z" },
    { title: "Staff Accountant", company: "Other", location: "Paris, France", remote: false, type: "Full-time", description: "", apply_url: "https://example.com/b", posted_at: "2026-11-10T00:00:00.000Z" },
  ], { q: "accountant Accra" });
  assert.deepEqual(result.jobs.map((job) => job.company), ["FHI 360"]);
});

test("expiry only removes ids missing from the latest complete board", () => {
  assert.deepEqual(
    diffStaleIds(["greenhouse_acme_1", "greenhouse_acme_2"], ["greenhouse_acme_2"]),
    ["greenhouse_acme_1"]
  );
  assert.deepEqual(diffStaleIds(["a"], ["a"]), []);
});

test("rows sent to the database do not include crawler-only fields", () => {
  const row = toRow({
    external_id: "workday_x_1",
    title: "Nurse",
    company: "Clinic",
    location: "Accra, Ghana",
    remote: false,
    type: "",
    description: "",
    apply_url: "https://ccf.wd1.myworkdayjobs.com/clevelandcliniccareers/job/Accra/Nurse_1",
    source: "workday",
    posted_at: "2026-11-17T00:00:00.000Z",
    date_quality: "exact",
    _externalPath: "/job/x",
  });
  assert.equal(row.date_quality, undefined);
  assert.equal(row._externalPath, undefined);
  assert.equal(row.apply_url.includes("/wday/"), false);
});
