// Measures what a shopper waits for, the way a phone would see it: time to the first words on screen and to the
// finished answer, for each kind of question, one at a time and with several shoppers at once. Writes a Markdown
// table to local/latency.md. Rows it logs are removed afterwards so the store's report stays clean.
//   node scripts/latency.mjs
import { writeFileSync } from "node:fs";
import { API, sql } from "./sb.mjs";

const SESSION = "latency";

async function askOnce(q, extra = {}) {
  const t0 = performance.now();
  const res = await fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ q, store: "brendale", session: SESSION, ...extra }) });
  let first = 0, buffer = "", last = null;
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (res.status !== 200) console.log("failed:", res.status, line.slice(0, 200));
      if (!first && (msg.type === "delta" || msg.type === "answer")) first = performance.now() - t0;
      if (msg.type === "answer") last = msg;
    }
  }
  return { status: res.status, first, total: performance.now() - t0, route: last?.route, serverMs: last?.timing?.server_ms, planMs: last?.timing?.plan_ms };
}

const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const s = ms => `${(ms / 1000).toFixed(2)} s`;

const GROUPS = [
  ["Store fact", ["where are the toilets", "where is the service desk", "do you have a toilet"]],
  ["Exact product word", ["tent pegs", "gas canister", "head torch", "camping chairs", "kids sleeping bag", "esky", "fishing line", "soft plastics"]],
  ["Ranking over the whole catalogue", ["cheapest fishing rod", "best tent", "biggest esky", "warmest sleeping bag", "tent under $100", "longest fishing rod"]],
  ["Several things at once", ["a tent, a stove and some gas", "fishing rod, reel and line", "i want a fishing hook, a tent, a fishing rod, and sunscreen"]],
  ["Starter kit", ["camping weekend for 4", "what should i bring on a fishing trip"]],
  ["AI, knows the shelf", ["i want to catch some big ass fish", "something to keep the mozzies away", "comfy chair for the beach", "what keeps beers coldest", "good first rod for my son", "how do i stop getting sunburnt", "do you price match", "are you open sunday"]],
  ["AI, plans its own search first", ["tent for a family of five that's easy to put up", "gas bottle refill", "something for my dad who likes the outdoors", "what do i need to go hiking in the rain"]],
];

const rows = [];
for (const [name, questions] of GROUPS) {
  // Only the AI questions need to be real, so the rest stay out of the server's limit of 60 real questions a minute.
  const extra = name.startsWith("AI") ? {} : { dry: true };
  const runs = [];
  for (let round = 0; round < 2; round++) for (const q of questions) runs.push(await askOnce(q, extra));
  const bad = runs.filter(r => r.status !== 200).length;
  rows.push({ name, n: runs.length, routes: [...new Set(runs.map(r => r.route))].join(", "), first50: pct(runs.map(r => r.first), 0.5), first95: pct(runs.map(r => r.first), 0.95), total50: pct(runs.map(r => r.total), 0.5), worst: Math.max(...runs.map(r => r.total)), bad });
  console.log(name, rows[rows.length - 1]);
}

// Several shoppers asking at the same moment. Dry runs do everything except call the AI, so this tests our servers.
const crowd = [];
for (const size of [5, 10, 25, 50]) {
  const questions = GROUPS[1][1].concat(GROUPS[2][1]);
  const t0 = performance.now();
  const runs = await Promise.all(Array.from({ length: size }, (_, i) => askOnce(questions[i % questions.length], { dry: true })));
  crowd.push({ size, median: pct(runs.map(r => r.total), 0.5), p95: pct(runs.map(r => r.total), 0.95), worst: Math.max(...runs.map(r => r.total)), bad: runs.filter(r => r.status !== 200).length, wall: performance.now() - t0 });
  console.log("crowd", crowd[crowd.length - 1]);
}
// Real AI answers at the same moment, because the model is the part we don't run ourselves.
const aiQuestions = GROUPS[5][1];
const aiCrowdT0 = performance.now();
const aiRuns = await Promise.all(aiQuestions.map(q => askOnce(q)));
const aiCrowd = { size: aiRuns.length, first50: pct(aiRuns.map(r => r.first), 0.5), worstFirst: Math.max(...aiRuns.map(r => r.first)), worst: Math.max(...aiRuns.map(r => r.total)), wall: performance.now() - aiCrowdT0, bad: aiRuns.filter(r => r.status !== 200 || r.route !== "ai").length };
console.log("ai crowd", aiCrowd);

await sql(`delete from questions where session = '${SESSION}'`);

const when = new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" });
const md = [
  `# Measured latency`,
  ``,
  `Measured ${when} from a home connection in Brisbane to the server in Sydney, on the free hosting plan, with the full 11,898 product catalogue. A phone on 4G adds its own network time on top.`,
  ``,
  `| Kind of question | Answered by | Asked | First words, median | First words, 95th | Finished, median | Slowest | Failed |`,
  `|---|---|---|---|---|---|---|---|`,
  ...rows.map(r => `| ${r.name} | ${r.routes} | ${r.n} | ${s(r.first50)} | ${s(r.first95)} | ${s(r.total50)} | ${s(r.worst)} | ${r.bad} |`),
  ``,
  `## Several shoppers at the same moment`,
  ``,
  `Everything except the AI call, all sent at once.`,
  ``,
  `| At once | Median | 95th | Slowest | Failed |`,
  `|---|---|---|---|---|`,
  ...crowd.map(c => `| ${c.size} | ${s(c.median)} | ${s(c.p95)} | ${s(c.worst)} | ${c.bad} |`),
  ``,
  `${aiCrowd.size} real AI questions at once: first words median ${s(aiCrowd.first50)}, slowest first words ${s(aiCrowd.worstFirst)}, slowest finished ${s(aiCrowd.worst)}, ${aiCrowd.bad} failed.`,
  ``,
].join("\n");
writeFileSync(new URL("../local/latency.md", import.meta.url), md);
console.log(md);
