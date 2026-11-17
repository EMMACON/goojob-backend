const { request, RobotsError } = require("../services/http-client");
const { loadBoards } = require("../services/boards");
const { saveBoardJobs } = require("./lib/save-board");

const PLACE_QUERIES = ["Accra", "Kumasi", "Lagos", "Nairobi", "Johannesburg", "Cape Town", "Ghana", "Kenya", "Nigeria"];
const ROLE_QUERIES = ["nurse", "teacher", "accountant"];

function workdayPostedAt(postedOn, now = Date.now()) {
  const text = String(postedOn || "").trim();
  if (!text) return { posted_at: null, date_quality: "unknown" };
  if (/today/i.test(text)) return { posted_at: new Date(now).toISOString(), date_quality: "exact" };
  if (/yesterday/i.test(text)) return { posted_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(), date_quality: "exact" };
  const match = text.match(/(\d+)\s*\+?\s*days?/i);
  if (!match) return { posted_at: null, date_quality: "unknown" };
  const days = Number(match[1]);
  const coarse = /\+/.test(text);
  if (coarse) return { posted_at: null, date_quality: "coarse" };
  return { posted_at: new Date(now - days * 24 * 60 * 60 * 1000).toISOString(), date_quality: "exact" };
}

function requisitionId(posting) {
  const bullet = Array.isArray(posting.bulletFields) ? posting.bulletFields[0] : "";
  if (bullet) return String(bullet).replace(/[^\w.-]/g, "");
  const path = String(posting.externalPath || "");
  const match = path.match(/_([A-Za-z0-9-]+)\/?$/);
  return match ? match[1] : "";
}

function locationFromPath(externalPath) {
  const match = String(externalPath || "").match(/^\/job\/([^/]+)\//);
  if (!match) return "";
  return match[1].replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function mapWorkdayJob(board, posting) {
  const id = requisitionId(posting);
  const externalPath = String(posting.externalPath || "");
  if (!id || !externalPath.startsWith("/job/")) return null;
  const title = String(posting.title || "").trim();
  if (!title) return null;
  let location = String(posting.locationsText || "").trim();
  // Some boards leave locationsText empty, or say "7 Locations", while the
  // public path still names the primary city ("/job/Accra/...").
  if (!location || /^\d+\s+locations?$/i.test(location)) {
    location = locationFromPath(externalPath);
  }
  const dated = workdayPostedAt(posting.postedOn);
  const remote = /remote|anywhere|home based/i.test(location);
  return {
    external_id: `workday_${board.tenant}_${board.site}_${id}`.toLowerCase(),
    title,
    company: board.company,
    location: /^\d+\s+locations?$/i.test(location) ? "" : location,
    remote,
    type: "",
    description: "",
    apply_url: `https://${board.host}/${board.site}${externalPath}`,
    source: "workday",
    posted_at: dated.posted_at,
    date_quality: dated.date_quality,
    _externalPath: externalPath,
  };
}

function queryHits(job, query) {
  const blob = `${job.title} ${job.location}`.toLowerCase();
  const q = String(query || "").toLowerCase();
  if (q === "nurse") return /\b(nurse|nurses|nursing|rn)\b/.test(blob);
  if (q === "teacher") return /\b(teacher|teachers|teaching)\b/.test(blob);
  if (q === "accountant") return /\b(accountant|accountants|accounting)\b/.test(blob);
  return q.split(/\s+/).every((word) => word && blob.includes(word));
}

async function postJobs(board, body) {
  const url = `https://${board.host}/wday/cxs/${board.tenant}/${board.site}/jobs`;
  const res = await request("POST", url, {
    data: body,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    timeout: 20000,
  });
  if (res.status === 404 || res.status === 422) return { total: 0, jobPostings: [], missing: true };
  if (res.status >= 400) {
    const err = new Error(`Workday HTTP ${res.status} for ${board.company}`);
    err.status = res.status;
    throw err;
  }
  const data = res.data || {};
  return { total: Number(data.total) || 0, jobPostings: data.jobPostings || [] };
}

function pageCap(depth) {
  const fromEnv = Number(process.env.WORKDAY_PAGE_CAP);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return depth === "full" ? 12 : 6;
}

function rolePages(board, query, depth) {
  const focus = board.focus || [];
  const deep = focus.includes(query) || (query === "accountant" && focus.includes("accountant"));
  if (!deep) return 1;
  return depth === "full" ? 6 : 3;
}

async function fetchWorkdayBoard(board, { depth = "quick" } = {}) {
  const cap = pageCap(depth);
  const jobs = new Map();
  let projectedTotal = 0;
  let reachedEnd = false;
  let sawCoarsePage = false;

  for (let page = 0; page < cap; page += 1) {
    const data = await postJobs(board, {
      appliedFacets: {},
      limit: 20,
      offset: page * 20,
      searchText: "",
    });
    projectedTotal = data.total || projectedTotal;
    const batch = data.jobPostings || [];
    if (!batch.length) {
      reachedEnd = true;
      break;
    }
    let coarse = 0;
    for (const posting of batch) {
      const job = mapWorkdayJob(board, posting);
      if (!job) continue;
      if (job.date_quality === "coarse") coarse += 1;
      jobs.set(job.external_id, job);
    }
    if ((page + 1) * 20 >= projectedTotal) {
      reachedEnd = true;
      break;
    }
    if (coarse === batch.length) {
      sawCoarsePage = true;
      break;
    }
  }

  const queries = [
    ...PLACE_QUERIES.map((q) => ({ q, pages: 1 })),
    ...ROLE_QUERIES.map((q) => ({ q, pages: rolePages(board, q, depth) })),
  ];
  for (const { q, pages } of queries) {
    for (let page = 0; page < pages; page += 1) {
      let data;
      try {
        data = await postJobs(board, {
          appliedFacets: {},
          limit: 20,
          offset: page * 20,
          searchText: q,
        });
      } catch (err) {
        console.error(`[WORKDAY] ${board.company} search ${q}: ${err.message}`);
        break;
      }
      const batch = data.jobPostings || [];
      let kept = 0;
      for (const posting of batch) {
        const job = mapWorkdayJob(board, posting);
        if (!job || !queryHits(job, q)) continue;
        jobs.set(job.external_id, job);
        kept += 1;
      }
      if (batch.length < 20 || kept === 0) break;
    }
  }

  const complete = reachedEnd && !sawCoarsePage && projectedTotal <= jobs.size + 5;
  return {
    jobs: [...jobs.values()],
    projectedTotal,
    complete,
    company: board.company,
  };
}

async function runWorkdayCrawler({ boards = null, depth = "quick", onProgress } = {}) {
  const list = boards || loadBoards().workday;
  let totalJobs = 0;
  let projected = 0;
  const errors = [];
  for (const board of list) {
    try {
      const result = await fetchWorkdayBoard(board, { depth });
      projected += result.projectedTotal || result.jobs.length;
      if (result.jobs.length || result.complete) {
        await saveBoardJobs({
          prefix: `workday_${board.tenant}_${board.site}_`.toLowerCase(),
          jobs: result.jobs,
          complete: result.complete,
        });
      }
      totalJobs += result.jobs.length;
      if (onProgress) onProgress({ source: "workday", company: board.company, totalJobs, projected: result.projectedTotal });
      console.log(`[WORKDAY] ${board.company}: fetched ${result.jobs.length} / reported ${result.projectedTotal}`);
    } catch (err) {
      if (err instanceof RobotsError || err.code === "ROBOTS") {
        console.error(`[WORKDAY] ${board.company} skipped: ${err.message}`);
      } else {
        console.error(`[WORKDAY] ${board.company}: ${err.message}`);
      }
      errors.push({ company: board.company, error: err.message });
    }
  }
  return { totalJobs, projected, companies: list.length, errors };
}

module.exports = {
  workdayPostedAt,
  mapWorkdayJob,
  queryHits,
  fetchWorkdayBoard,
  runWorkdayCrawler,
};
