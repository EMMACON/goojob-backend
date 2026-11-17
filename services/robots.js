const axios = require("axios");

const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ type: key, path: value });
    } else if (key === "crawl-delay" && current) {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelaySec = delay;
    }
  }
  return groups;
}

function groupFor(groups, ua) {
  const token = String(ua || "goojob").toLowerCase();
  const specific = groups.filter((group) => group.agents.some((agent) => agent !== "*" && token.includes(agent)));
  const chosen = specific.length ? specific : groups.filter((group) => group.agents.includes("*"));
  const rules = [];
  let crawlDelaySec = null;
  for (const group of chosen) {
    rules.push(...group.rules);
    if (group.crawlDelaySec != null) crawlDelaySec = group.crawlDelaySec;
  }
  return { rules, crawlDelaySec };
}

function ruleToRegExp(path) {
  if (!path) return null;
  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}`);
}

// Longest match wins. An equally long Allow beats Disallow.
function pathAllowed(rules, path) {
  const target = path.startsWith("/") ? path : `/${path}`;
  let bestLen = -1;
  let bestType = "allow";
  for (const rule of rules || []) {
    if (!rule.path) continue;
    const re = ruleToRegExp(rule.path);
    if (!re || !re.test(target)) continue;
    const len = rule.path.length;
    if (len > bestLen || (len === bestLen && rule.type === "allow")) {
      bestLen = len;
      bestType = rule.type;
    }
  }
  return bestType !== "disallow";
}

async function loadOrigin(origin) {
  try {
    const res = await axios.get(`${origin}/robots.txt`, {
      timeout: 8000,
      maxRedirects: 2,
      validateStatus: () => true,
      headers: { "User-Agent": "Goojob/1.0 (+https://goojob.io/bot)", Accept: "text/plain,*/*" },
      responseType: "text",
      transformResponse: [(value) => value],
    });
    const ctype = String(res.headers["content-type"] || "").toLowerCase();
    const body = String(res.data || "");
    if (res.status === 404 || ctype.includes("html") || !/user-agent\s*:/i.test(body)) {
      return { rules: [], crawlDelaySec: null };
    }
    if (res.status >= 500) {
      return { rules: [{ type: "disallow", path: "/" }], crawlDelaySec: null };
    }
    if (res.status !== 200) {
      return { rules: [], crawlDelaySec: null };
    }
    const parsed = groupFor(parseRobots(body), "goojob");
    return parsed;
  } catch {
    return { rules: [], crawlDelaySec: null };
  }
}

async function robotsFor(url) {
  const parsed = new URL(url);
  const origin = parsed.origin;
  let entry = cache.get(origin);
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    entry = { at: Date.now(), policy: await loadOrigin(origin) };
    cache.set(origin, entry);
  }
  const path = `${parsed.pathname}${parsed.search}`;
  const delaySec = entry.policy.crawlDelaySec;
  return {
    allowed: pathAllowed(entry.policy.rules, path),
    crawlDelayMs: delaySec ? Math.min(delaySec * 1000, 5000) : 0,
  };
}

function clearRobotsCache() {
  cache.clear();
}

module.exports = {
  parseRobots,
  groupFor,
  pathAllowed,
  robotsFor,
  clearRobotsCache,
};
