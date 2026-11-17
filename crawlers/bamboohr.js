const { getOk, RobotsError } = require("../services/http-client");
const { loadBoards } = require("../services/boards");
const { saveBoardJobs } = require("./lib/save-board");

const COMPANY_NAMES = {
  africapractice: "Africa Practice",
  marybeggclinic: "Mary Begg Clinic",
  discoverafricagroup: "Discover Africa Group",
  navinurses: "Navi Nurses",
  doctorshospital: "Doctors Hospital",
  alnafrica: "ALN Africa",
  natcarbonafrica: "Nature's Carbon Africa",
  childrenshospitalfoundation: "Children's Hospital Foundation",
  hcchospital: "Harrison County Hospital",
  westafricablue: "West Africa Blue",
  thinkglobalschool: "Think Global School",
  greenschool: "Green School",
  teachingattherightlevel: "Teaching at the Right Level",
};

function mapBambooJob(slug, row) {
  const id = String(row.id || "").trim();
  const title = String(row.jobOpeningName || row.title || "").trim();
  if (!id || !title) return null;
  const loc = row.location || {};
  const location = [loc.city, loc.state, loc.country].filter(Boolean).join(", ");
  return {
    external_id: `bamboohr_${slug}_${id}`,
    title,
    company: row.companyName || COMPANY_NAMES[slug] || slug,
    location,
    remote: row.isRemote === true || /remote/i.test(location),
    type: row.employmentStatusLabel || "",
    description: "",
    apply_url: `https://${slug}.bamboohr.com/careers/${id}`,
    source: "bamboohr",
    posted_at: null,
    date_quality: "unknown",
  };
}

async function fetchBambooCompany(slug) {
  const url = `https://${slug}.bamboohr.com/careers/list`;
  const { status, data } = await getOk(url, { headers: { Accept: "application/json" }, timeout: 12000 });
  if (status === 404 || !data || !Array.isArray(data.result)) return { jobs: [], ok: status === 200 };
  const jobs = data.result.map((row) => mapBambooJob(slug, row)).filter(Boolean);
  return { jobs, ok: true, projectedTotal: (data.meta && data.meta.totalCount) || jobs.length };
}

async function runBambooHrCrawler({ slugs = null, onProgress } = {}) {
  const list = slugs || loadBoards().bamboohr;
  let totalJobs = 0;
  const errors = [];
  for (const slug of list) {
    try {
      const result = await fetchBambooCompany(slug);
      if (result.ok) {
        await saveBoardJobs({
          prefix: `bamboohr_${slug}_`,
          jobs: result.jobs,
          complete: true,
        });
        totalJobs += result.jobs.length;
      }
      if (onProgress) onProgress({ source: "bamboohr", slug, totalJobs });
      console.log(`[BAMBOOHR] ${slug}: ${result.jobs.length} jobs`);
    } catch (err) {
      if (err instanceof RobotsError || err.code === "ROBOTS") {
        console.error(`[BAMBOOHR] ${slug} skipped: ${err.message}`);
      } else {
        console.error(`[BAMBOOHR] ${slug}: ${err.message}`);
      }
      errors.push({ slug, error: err.message });
    }
  }
  return { totalJobs, companies: list.length, errors };
}

module.exports = { mapBambooJob, fetchBambooCompany, runBambooHrCrawler };
