const axios = require("axios");
const { robotsFor } = require("./robots");

const UA = "Goojob/1.0 (+https://goojob.io/bot)";
const nextSlot = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pace(origin, minGapMs) {
  const gap = Math.min(Math.max(minGapMs || 250, 200), 5000);
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(origin) || 0);
  nextSlot.set(origin, slot + gap);
  const wait = slot - now;
  if (wait) await sleep(wait);
}

class RobotsError extends Error {
  constructor(url) {
    super(`robots.txt disallows ${url}`);
    this.code = "ROBOTS";
    this.url = url;
  }
}

async function request(method, url, { data, headers, timeout = 15000 } = {}) {
  const verdict = await robotsFor(url);
  if (!verdict.allowed) throw new RobotsError(url);
  const origin = new URL(url).origin;
  await pace(origin, verdict.crawlDelayMs || 250);
  const res = await axios({
    method,
    url,
    data,
    timeout,
    maxRedirects: 3,
    validateStatus: () => true,
    headers: {
      "User-Agent": UA,
      Accept: "application/json, application/xml, text/xml, text/plain, */*",
      ...headers,
    },
  });
  return res;
}

async function getOk(url, opts) {
  const res = await request("GET", url, opts);
  if (res.status === 404) return { status: 404, data: null };
  if (res.status >= 400) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, data: res.data };
}

module.exports = {
  UA,
  request,
  getOk,
  RobotsError,
  pace,
};
