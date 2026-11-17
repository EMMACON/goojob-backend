const fs = require("fs");
const path = require("path");

let cached = null;

function loadBoards() {
  if (cached) return cached;
  const file = path.join(__dirname, "..", "data", "boards.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  cached = {
    greenhouse: Array.isArray(raw.greenhouse) ? raw.greenhouse : [],
    workday: Array.isArray(raw.workday) ? raw.workday : [],
    oracle: Array.isArray(raw.oracle) ? raw.oracle : [],
    bamboohr: Array.isArray(raw.bamboohr) ? raw.bamboohr : [],
    sitemaps: Array.isArray(raw.sitemaps) ? raw.sitemaps : [],
    verifiedOn: raw.verifiedOn || null,
  };
  return cached;
}

module.exports = { loadBoards };
