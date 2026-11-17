require("dotenv").config();

const { runQuickCrawl, runFullCrawl } = require("../crawlers");

const which = process.argv[2] || "quick";
if (which !== "quick" && which !== "full") {
  console.error("Usage: node scripts/crawl.js quick|full");
  process.exit(1);
}

const run = which === "full" ? runFullCrawl : runQuickCrawl;
run()
  .then((result) => {
    const counts = {};
    for (const [name, row] of Object.entries(result.summary || {})) {
      counts[name] = {
        totalJobs: row && row.totalJobs,
        projected: row && row.projected,
        skipped: row && row.skipped,
        error: row && row.error,
      };
    }
    console.log(JSON.stringify({
      depth: result.depth,
      totalJobs: result.totalJobs,
      durationSeconds: result.durationSeconds,
      counts,
    }, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
