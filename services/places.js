// Places used to pull a city or country out of a free-text query and to
// tidy location strings. Kept deliberately conservative: 2-letter codes are
// not treated as places inside a typed query ("it", "in", "no"), because
// those are normal words. Full names and unambiguous cities are.

const COUNTRY_BY_CODE = {
  af: "Afghanistan", al: "Albania", dz: "Algeria", ad: "Andorra", ao: "Angola",
  ag: "Antigua and Barbuda", ar: "Argentina", am: "Armenia", au: "Australia",
  at: "Austria", az: "Azerbaijan", bs: "Bahamas", bh: "Bahrain", bd: "Bangladesh",
  bb: "Barbados", by: "Belarus", be: "Belgium", bz: "Belize", bj: "Benin",
  bt: "Bhutan", bo: "Bolivia", ba: "Bosnia and Herzegovina", bw: "Botswana",
  br: "Brazil", bn: "Brunei", bg: "Bulgaria", bf: "Burkina Faso", bi: "Burundi",
  cv: "Cabo Verde", kh: "Cambodia", cm: "Cameroon", ca: "Canada", cf: "Central African Republic",
  td: "Chad", cl: "Chile", cn: "China", co: "Colombia", km: "Comoros",
  cg: "Congo", cd: "Democratic Republic of the Congo", cr: "Costa Rica",
  ci: "Côte d'Ivoire", hr: "Croatia", cu: "Cuba", cy: "Cyprus", cz: "Czechia",
  dk: "Denmark", dj: "Djibouti", dm: "Dominica", do: "Dominican Republic",
  ec: "Ecuador", eg: "Egypt", sv: "El Salvador", gq: "Equatorial Guinea",
  er: "Eritrea", ee: "Estonia", sz: "Eswatini", et: "Ethiopia", fj: "Fiji",
  fi: "Finland", fr: "France", ga: "Gabon", gm: "Gambia", ge: "Georgia",
  de: "Germany", gh: "Ghana", gr: "Greece", gd: "Grenada", gt: "Guatemala",
  gn: "Guinea", gw: "Guinea-Bissau", gy: "Guyana", ht: "Haiti", hn: "Honduras",
  hu: "Hungary", is: "Iceland", in: "India", id: "Indonesia", ir: "Iran",
  iq: "Iraq", ie: "Ireland", il: "Israel", it: "Italy", jm: "Jamaica",
  jp: "Japan", jo: "Jordan", kz: "Kazakhstan", ke: "Kenya", ki: "Kiribati",
  kw: "Kuwait", kg: "Kyrgyzstan", la: "Laos", lv: "Latvia", lb: "Lebanon",
  ls: "Lesotho", lr: "Liberia", ly: "Libya", li: "Liechtenstein", lt: "Lithuania",
  lu: "Luxembourg", mg: "Madagascar", mw: "Malawi", my: "Malaysia", mv: "Maldives",
  ml: "Mali", mt: "Malta", mh: "Marshall Islands", mr: "Mauritania", mu: "Mauritius",
  mx: "Mexico", fm: "Micronesia", md: "Moldova", mc: "Monaco", mn: "Mongolia",
  me: "Montenegro", ma: "Morocco", mz: "Mozambique", mm: "Myanmar", na: "Namibia",
  nr: "Nauru", np: "Nepal", nl: "Netherlands", nz: "New Zealand", ni: "Nicaragua",
  ne: "Niger", ng: "Nigeria", kp: "North Korea", mk: "North Macedonia", no: "Norway",
  om: "Oman", pk: "Pakistan", pw: "Palau", pa: "Panama", pg: "Papua New Guinea",
  py: "Paraguay", pe: "Peru", ph: "Philippines", pl: "Poland", pt: "Portugal",
  qa: "Qatar", ro: "Romania", ru: "Russia", rw: "Rwanda", kn: "Saint Kitts and Nevis",
  lc: "Saint Lucia", vc: "Saint Vincent and the Grenadines", ws: "Samoa",
  sm: "San Marino", st: "São Tomé and Príncipe", sa: "Saudi Arabia", sn: "Senegal",
  rs: "Serbia", sc: "Seychelles", sl: "Sierra Leone", sg: "Singapore", sk: "Slovakia",
  si: "Slovenia", sb: "Solomon Islands", so: "Somalia", za: "South Africa",
  kr: "South Korea", ss: "South Sudan", es: "Spain", lk: "Sri Lanka", sd: "Sudan",
  sr: "Suriname", se: "Sweden", ch: "Switzerland", sy: "Syria", tw: "Taiwan",
  tj: "Tajikistan", tz: "Tanzania", th: "Thailand", tl: "Timor-Leste", tg: "Togo",
  to: "Tonga", tt: "Trinidad and Tobago", tn: "Tunisia", tr: "Turkey",
  tm: "Turkmenistan", tv: "Tuvalu", ug: "Uganda", ua: "Ukraine", ae: "United Arab Emirates",
  gb: "United Kingdom", us: "United States", uy: "Uruguay", uz: "Uzbekistan",
  vu: "Vanuatu", ve: "Venezuela", vn: "Vietnam", ye: "Yemen", zm: "Zambia", zw: "Zimbabwe",
};

// Spoken names that should resolve in a query. Two-letter codes are intentionally
// absent here — they are handled only when cleaning a stored location, where
// uppercase US state codes and lowercase country codes can be told apart.
const COUNTRY_ALIASES = {
  usa: "United States",
  "u.s.": "United States",
  "u.s.a.": "United States",
  america: "United States",
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  britain: "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  wales: "United Kingdom",
  holland: "Netherlands",
  uae: "United Arab Emirates",
  "czech republic": "Czechia",
  "south korea": "South Korea",
  "north korea": "North Korea",
  "ivory coast": "Côte d'Ivoire",
  russia: "Russia",
  vietnam: "Vietnam",
  turkey: "Turkey",
  tanzania: "Tanzania",
};

const US_STATES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia",
  "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj",
  "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt",
  "va", "wa", "wv", "wi", "wy", "dc",
]);

const CA_PROVINCES = new Set(["ab", "bc", "mb", "nb", "nl", "ns", "nt", "nu", "on", "pe", "qc", "sk", "yt"]);

// Cities that are not also everyday English words used in job titles
// ("mobile", "reading", "nice"). Accra is the case the search was failing.
const CITY_LIST = [
  ["accra", "Accra", "Ghana"],
  ["kumasi", "Kumasi", "Ghana"],
  ["takoradi", "Takoradi", "Ghana"],
  ["tamale", "Tamale", "Ghana"],
  ["tema", "Tema", "Ghana"],
  ["lagos", "Lagos", "Nigeria"],
  ["port harcourt", "Port Harcourt", "Nigeria"],
  ["abuja", "Abuja", "Nigeria"],
  ["nairobi", "Nairobi", "Kenya"],
  ["mombasa", "Mombasa", "Kenya"],
  ["nanyuki", "Nanyuki", "Kenya"],
  ["cairo", "Cairo", "Egypt"],
  ["johannesburg", "Johannesburg", "South Africa"],
  ["cape town", "Cape Town", "South Africa"],
  ["durban", "Durban", "South Africa"],
  ["pretoria", "Pretoria", "South Africa"],
  ["casablanca", "Casablanca", "Morocco"],
  ["marrakech", "Marrakech", "Morocco"],
  ["tunis", "Tunis", "Tunisia"],
  ["algiers", "Algiers", "Algeria"],
  ["addis ababa", "Addis Ababa", "Ethiopia"],
  ["dar es salaam", "Dar es Salaam", "Tanzania"],
  ["kampala", "Kampala", "Uganda"],
  ["kigali", "Kigali", "Rwanda"],
  ["dakar", "Dakar", "Senegal"],
  ["abidjan", "Abidjan", "Côte d'Ivoire"],
  ["lusaka", "Lusaka", "Zambia"],
  ["harare", "Harare", "Zimbabwe"],
  ["douala", "Douala", "Cameroon"],
  ["yaounde", "Yaoundé", "Cameroon"],
  ["new york", "New York", "United States"],
  ["nyc", "New York", "United States"],
  ["san francisco", "San Francisco", "United States"],
  ["los angeles", "Los Angeles", "United States"],
  ["chicago", "Chicago", "United States"],
  ["seattle", "Seattle", "United States"],
  ["boston", "Boston", "United States"],
  ["austin", "Austin", "United States"],
  ["denver", "Denver", "United States"],
  ["houston", "Houston", "United States"],
  ["dallas", "Dallas", "United States"],
  ["atlanta", "Atlanta", "United States"],
  ["miami", "Miami", "United States"],
  ["philadelphia", "Philadelphia", "United States"],
  ["phoenix", "Phoenix", "United States"],
  ["washington", "Washington", "United States"],
  ["london", "London", "United Kingdom"],
  ["manchester", "Manchester", "United Kingdom"],
  ["birmingham", "Birmingham", "United Kingdom"],
  ["edinburgh", "Edinburgh", "United Kingdom"],
  ["glasgow", "Glasgow", "United Kingdom"],
  ["dublin", "Dublin", "Ireland"],
  ["paris", "Paris", "France"],
  ["lyon", "Lyon", "France"],
  ["marseille", "Marseille", "France"],
  ["toulouse", "Toulouse", "France"],
  ["berlin", "Berlin", "Germany"],
  ["munich", "Munich", "Germany"],
  ["hamburg", "Hamburg", "Germany"],
  ["frankfurt", "Frankfurt", "Germany"],
  ["amsterdam", "Amsterdam", "Netherlands"],
  ["rotterdam", "Rotterdam", "Netherlands"],
  ["utrecht", "Utrecht", "Netherlands"],
  ["brussels", "Brussels", "Belgium"],
  ["zurich", "Zurich", "Switzerland"],
  ["geneva", "Geneva", "Switzerland"],
  ["vienna", "Vienna", "Austria"],
  ["prague", "Prague", "Czechia"],
  ["warsaw", "Warsaw", "Poland"],
  ["krakow", "Krakow", "Poland"],
  ["budapest", "Budapest", "Hungary"],
  ["stockholm", "Stockholm", "Sweden"],
  ["copenhagen", "Copenhagen", "Denmark"],
  ["oslo", "Oslo", "Norway"],
  ["helsinki", "Helsinki", "Finland"],
  ["madrid", "Madrid", "Spain"],
  ["barcelona", "Barcelona", "Spain"],
  ["lisbon", "Lisbon", "Portugal"],
  ["rome", "Rome", "Italy"],
  ["milan", "Milan", "Italy"],
  ["athens", "Athens", "Greece"],
  ["bucharest", "Bucharest", "Romania"],
  ["istanbul", "Istanbul", "Turkey"],
  ["dubai", "Dubai", "United Arab Emirates"],
  ["abu dhabi", "Abu Dhabi", "United Arab Emirates"],
  ["doha", "Doha", "Qatar"],
  ["riyadh", "Riyadh", "Saudi Arabia"],
  ["tel aviv", "Tel Aviv", "Israel"],
  ["singapore", "Singapore", "Singapore"],
  ["hong kong", "Hong Kong", "Hong Kong"],
  ["tokyo", "Tokyo", "Japan"],
  ["osaka", "Osaka", "Japan"],
  ["seoul", "Seoul", "South Korea"],
  ["beijing", "Beijing", "China"],
  ["shanghai", "Shanghai", "China"],
  ["shenzhen", "Shenzhen", "China"],
  ["bangalore", "Bengaluru", "India"],
  ["bengaluru", "Bengaluru", "India"],
  ["hyderabad", "Hyderabad", "India"],
  ["mumbai", "Mumbai", "India"],
  ["delhi", "Delhi", "India"],
  ["new delhi", "New Delhi", "India"],
  ["pune", "Pune", "India"],
  ["chennai", "Chennai", "India"],
  ["kolkata", "Kolkata", "India"],
  ["noida", "Noida", "India"],
  ["gurgaon", "Gurugram", "India"],
  ["gurugram", "Gurugram", "India"],
  ["sydney", "Sydney", "Australia"],
  ["melbourne", "Melbourne", "Australia"],
  ["brisbane", "Brisbane", "Australia"],
  ["auckland", "Auckland", "New Zealand"],
  ["wellington", "Wellington", "New Zealand"],
  ["toronto", "Toronto", "Canada"],
  ["vancouver", "Vancouver", "Canada"],
  ["montreal", "Montreal", "Canada"],
  ["ottawa", "Ottawa", "Canada"],
  ["calgary", "Calgary", "Canada"],
  ["sao paulo", "São Paulo", "Brazil"],
  ["rio de janeiro", "Rio de Janeiro", "Brazil"],
  ["mexico city", "Mexico City", "Mexico"],
  ["bogota", "Bogotá", "Colombia"],
  ["lima", "Lima", "Peru"],
  ["santiago", "Santiago", "Chile"],
  ["buenos aires", "Buenos Aires", "Argentina"],
  ["strasbourg", "Strasbourg", "France"],
  ["tashkent", "Tashkent", "Uzbekistan"],
  ["agadir", "Agadir", "Morocco"],
];

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const CITIES = new Map();
for (const [key, city, country] of CITY_LIST) {
  CITIES.set(fold(key), { city, country });
}

const COUNTRY_BY_NAME = new Map();
for (const [code, name] of Object.entries(COUNTRY_BY_CODE)) {
  COUNTRY_BY_NAME.set(fold(name), { name, code });
}
for (const [alias, name] of Object.entries(COUNTRY_ALIASES)) {
  const canonical = COUNTRY_BY_NAME.get(fold(name));
  COUNTRY_BY_NAME.set(fold(alias), canonical || { name, code: "" });
}

const CITY_PHRASES = [...CITIES.keys()].filter((k) => k.includes(" ")).sort((a, b) => b.length - a.length);

function citiesInCountry(countryName) {
  const want = fold(countryName);
  const cities = [];
  for (const [, city, country] of CITY_LIST) {
    if (fold(country) === want && !cities.includes(city)) cities.push(city);
  }
  return cities;
}

function locationHasPlace(location, needle) {
  const loc = fold(location);
  const n = fold(needle);
  if (!n) return false;
  if (n.length >= 6) return loc.includes(n);
  return wholeWord(loc, n);
}

function lookupPlace(raw) {
  const key = fold(raw);
  if (!key) return null;
  const city = CITIES.get(key);
  if (city) {
    return { kind: "city", label: city.city, city: city.city, country: city.country };
  }
  const country = COUNTRY_BY_NAME.get(key);
  if (country) {
    return { kind: "country", label: country.name, name: country.name, code: country.code };
  }
  return null;
}

function wholeWord(haystack, needle) {
  const n = fold(needle);
  if (!n) return false;
  const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
  return re.test(fold(haystack));
}

// Does a normalized location string satisfy a place the user asked for?
function matchesPlace(location, wanted) {
  if (!wanted) return true;
  const loc = fold(location);
  const want = fold(wanted);
  if (!want) return true;
  if (want.length > 3 && loc.includes(want)) return true;
  if (want.length <= 3 && wholeWord(loc, want)) return true;

  const place = lookupPlace(want);
  if (place?.kind === "city") return locationHasPlace(loc, place.city);
  if (place?.kind === "country") {
    if (loc.includes(fold(place.name))) return true;
    if (place.code && wholeWord(loc, place.code)) return true;
    if (citiesInCountry(place.name).some((city) => locationHasPlace(loc, city))) return true;
    if (/\b(worldwide|anywhere)\b/.test(loc)) return true;
    return false;
  }

  // Explicit 2-letter filters: uppercase-style state codes stay states;
  // everything else in the country table is a country. Ambiguous codes
  // (CA, MA, DE, …) match either the state token or the country name.
  if (/^[a-z]{2}$/.test(want)) {
    const isState = US_STATES.has(want) || CA_PROVINCES.has(want);
    const countryName = COUNTRY_BY_CODE[want];
    if (isState && wholeWord(loc, want)) return true;
    if (countryName && loc.includes(fold(countryName))) return true;
    if (!isState && countryName && wholeWord(loc, want)) return true;
  }
  return false;
}

module.exports = {
  COUNTRY_BY_CODE,
  US_STATES,
  CA_PROVINCES,
  CITIES,
  CITY_PHRASES,
  fold,
  lookupPlace,
  wholeWord,
  matchesPlace,
  citiesInCountry,
  locationHasPlace,
};
