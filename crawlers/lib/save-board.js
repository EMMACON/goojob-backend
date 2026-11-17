const { upsertJobs } = require("../../services/db");
const { expireMissing, keepFirstPostedAt } = require("../../services/expiry");

async function saveBoardJobs({ prefix, jobs, complete }) {
  const prepared = await keepFirstPostedAt(jobs || []);
  const cleaned = prepared.filter((job) => job && job.external_id && job.title && job.apply_url);
  for (let i = 0; i < cleaned.length; i += 100) {
    await upsertJobs(cleaned.slice(i, i + 100));
  }
  let expiry = null;
  if (complete) {
    expiry = await expireMissing({
      prefix,
      seenIds: cleaned.map((job) => job.external_id),
    });
  }
  return { saved: cleaned.length, expiry };
}

module.exports = { saveBoardJobs };
