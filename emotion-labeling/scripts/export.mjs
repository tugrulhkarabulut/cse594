/**
 * Dump collected labels to CSV for the writeup / analysis.
 *   node scripts/export.mjs          -> remote (deployed) database
 *   node scripts/export.mjs --local  -> local dev database
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const where = process.argv.includes("--local") ? "--local" : "--remote";

const SQL = `
SELECT p.id            AS participant_id,
       p.display_name  AS participant_name,
       p.started_at,
       p.completed_at,
       l.position,
       l.tweet_id,
       t.text          AS tweet_text,
       l.chosen_label,
       l.gold_label,
       l.is_correct,
       l.dwell_ms,
       l.created_at
FROM labels l
JOIN participants p ON p.id = l.participant_id
JOIN tweets t       ON t.id = l.tweet_id
ORDER BY p.started_at, l.position`;

const raw = execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "emotion_labels", where, "--command", SQL, "--json"],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
);

// wrangler prints banner lines before the JSON payload
const rows = JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
if (!rows.length) {
  console.log("No labels recorded yet.");
  process.exit(0);
}

const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const cols = Object.keys(rows[0]);
const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");

writeFileSync("labels.csv", csv + "\n");
console.log(`Wrote labels.csv: ${rows.length} labels from ${new Set(rows.map((r) => r.participant_id)).size} participants.`);
