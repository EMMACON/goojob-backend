const { request, RobotsError } = require("../services/http-client");
const { loadBoards } = require("../services/boards");
const { saveBoardJobs } = require("./lib/save-board");

const PLACE_QUERIES = ["Accra", "Kumasi", "Lagos", "Nairobi", "Johannesburg", "Ghana", "Kenya", "Nigeria", "South Africa"];
const ROLE_QUERIES = ["nurse", "teacher", "accountant"];

function oraclePostedAt(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { posted_at: `${text}T00:00:00.000Z`, date_quality: "exact" };
  }
  const parsed = new Date(text);
  if (!text || Number.isNaN(parsed.getTime())) return { posted_at: null, date_quality: "unknown" };
  return { posted_at: parsed.toISOString(), date_quality: "exact" };
}

function mapOracleJob(board, row) {
  const id = String(row.Id || "").trim();
  const title = String(row.Title || "").trim();
  if (!id || !title) return null;
  const location = String(row.PrimaryLocation || "").trim();
  const dated = oraclePostedAt(row.PostedDate);
  const workplace = `${row.WorkplaceType || ""} ${location}`;
  return {
    external_id: `oracle_${board.key}_${id}`,
    title,
    company: board.company,
    location,
    remote: /remote/i.test(workplace),
    type: row.JobSchedule || row.ContractType || row.JobType || "",
    description: row.ShortDescriptionStr || "",
    apply_url: `https://${board.host}/hcmUI/CandidateExperience/en/sites/${board.sitePath || board.siteNumber}/job/${id}`,
    source: "oracle",
    posted_at: dated.posted_at,
    date_quality: dated.date_quality,
  };
}

function pageCap(depth) {
  const fromEnv = Number(process.env.ORACLE_PAGE_CAP);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return depth === "full" ? 16 : 8;
}

async function fetchPage(board, { offset, limit, keyword }) {
  // Oracle's finder syntax is `findReqs;siteNumber=CX_1,limit=25,offset=0`.
  // Encoding the semicolons or commas makes the request fail.
  const kw = keyword ? `,keyword=${encodeURIComponent(keyword)}` : "";
  const finder = `findReqs;siteNumber=${board.siteNumber},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC${kw}`;
  const url = `https://${board.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`;
  const res = await request("GET", url, { timeout: 25000, headers: { Accept: "application/json" } });
  if (res.status === 404) return { total: 0, rows: [] };
  if (res.status >= 400) {
    const err = new Error(`Oracle HTTP ${res.status} for ${board.company}`);
    err.status = res.status;
    throw err;
  }
  const item = (res.data && res.data.items && res.data.items[0]) || {};
  return {
    total: Number(item.TotalJobsCount) || 0,
    rows: item.requisitionList || [],
  };
}

async function fetchOracleBoard(board, { depth = "quick" } = {}) {
  const cap = pageCap(depth);
  const limit = 25;
  const jobs = new Map();
  let projectedTotal = 0;
  let reachedOld = false;
  let reachedEnd = false;

  for (let page = 0; page < cap; page += 1) {
    const data = await fetchPage(board, { offset: page * limit, limit });
    projectedTotal = data.total || projectedTotal;
    if (!data.rows.length) {
      reachedEnd = true;
      break;
    }
    let old = 0;
    for (const row of data.rows) {
      const job = mapOracleJob(board, row);
      if (!job) continue;
      const posted = job.posted_at ? new Date(job.posted_at).getTime() : Date.now();
      if (Date.now() - posted > 50 * 24 * 60 * 60 * 1000) old += 1;
      jobs.set(job.external_id, job);
    }
    if ((page + 1) * limit >= projectedTotal) {
      reachedEnd = true;
      break;
    }
    if (old === data.rows.length) {
      reachedOld = true;
      break;
    }
  }

  const keywordPages = (board.focus || []).includes("nurse") || (board.focus || []).includes("hospitality") ? 2 : 1;
  for (const keyword of [...PLACE_QUERIES, ...ROLE_QUERIES]) {
    const pages = ROLE_QUERIES.includes(keyword) ? keywordPages : 1;
    for (let page = 0; page < pages; page += 1) {
      let data;
      try {
        data = await fetchPage(board, { offset: page * limit, limit, keyword });
      } catch (err) {
        console.error(`[ORACLE] ${board.company} keyword ${keyword}: ${err.message}`);
        break;
      }
      if (!data.rows.length) break;
      for (const row of data.rows) {
        const job = mapOracleJob(board, row);
        if (!job) continue;
        const blob = `${job.title} ${job.location}`.toLowerCase();
        const needle = keyword.toLowerCase();
        const roleOk = needle === "nurse"
          ? /\b(nurse|nurses|nursing|rn)\b/.test(blob)
          : needle === "teacher"
            ? /\b(teacher|teachers|teaching)\b/.test(blob)
            : needle === "accountant"
              ? /\b(accountant|accountants|accounting)\b/.test(blob)
              : needle.split(/\s+/).every((word) => blob.includes(word));
        if (!roleOk) continue;
        jobs.set(job.external_id, job);
      }
    }
  }

  const complete = (reachedEnd || reachedOld) && projectedTotal > 0 && projectedTotal <= cap * limit;
  return { jobs: [...jobs.values()], projectedTotal, complete, company: board.company };
}

async function runOracleCrawler({ boards = null, depth = "quick", onProgress } = {}) {
  const list = boards || loadBoards().oracle;
  let totalJobs = 0;
  let projected = 0;
  const errors = [];
  for (const board of list) {
    try {
      const result = await fetchOracleBoard(board, { depth });
      projected += result.projectedTotal || result.jobs.length;
      if (result.jobs.length || result.complete) {
        await saveBoardJobs({
          prefix: `oracle_${board.key}_`,
          jobs: result.jobs,
          complete: result.complete && result.projectedTotal <= result.jobs.length + 5,
        });
      }
      totalJobs += result.jobs.length;
      if (onProgress) onProgress({ source: "oracle", company: board.company, totalJobs });
      console.log(`[ORACLE] ${board.company}: fetched ${result.jobs.length} / reported ${result.projectedTotal}`);
    } catch (err) {
      if (err instanceof RobotsError || err.code === "ROBOTS") {
        console.error(`[ORACLE] ${board.company} skipped: ${err.message}`);
      } else {
        console.error(`[ORACLE] ${board.company}: ${err.message}`);
      }
      errors.push({ company: board.company, error: err.message });
    }
  }
  return { totalJobs, projected, companies: list.length, errors };
}

module.exports = {
  oraclePostedAt,
  mapOracleJob,
  fetchOracleBoard,
  runOracleCrawler,
};
