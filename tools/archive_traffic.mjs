// Archive GitHub traffic (clones + views) to CSVs so the numbers survive GitHub's 14-day
// window. Run by .github/workflows/traffic.yml, or locally with GH_TOKEN and REPO set.
// Upserts by date, so a weekly run loses nothing and never double-counts.
import fs from "fs";
import path from "path";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const REPO = process.env.REPO || process.env.GITHUB_REPOSITORY; // owner/name
if (!TOKEN || !REPO) { console.error("Need GH_TOKEN and REPO (owner/name)"); process.exit(1); }
const OUT = process.env.METRICS_DIR || "metrics";
fs.mkdirSync(OUT, { recursive: true });

async function api(p) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${p}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "daidocs-traffic",
    },
  });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

function upsert(file, days) {
  const map = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").trim().split("\n").slice(1)) {
      if (!line) continue;
      const [date, count, uniques] = line.split(",");
      map.set(date, { count: +count, uniques: +uniques });
    }
  }
  for (const d of days) map.set(d.timestamp.slice(0, 10), { count: d.count, uniques: d.uniques });
  const rows = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => `${date},${v.count},${v.uniques}`);
  fs.writeFileSync(file, "date,count,uniques\n" + rows.join("\n") + "\n");
  return map.size;
}

const clones = await api("traffic/clones");
const views = await api("traffic/views");
const c = upsert(path.join(OUT, "traffic-clones.csv"), clones.clones || []);
const v = upsert(path.join(OUT, "traffic-views.csv"), views.views || []);
console.log(`clones: ${c} days archived, views: ${v} days archived`);
