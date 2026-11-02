// Asks the deployed server a question every few minutes for hours, the way a quiet store would, and records how long
// each one took. Proves the server stays warm and the first question after a lull is still fast. Removes its log rows
// so the store's report stays clean, and appends each result to local/soak.csv.
//   node scripts/soak.mjs [hours]
import { appendFileSync } from "node:fs";
import { API, sql } from "./sb.mjs";

const HOURS = +process.argv[2] || 4, EVERY_MS = 5 * 60000, AI_EVERY = 6, SESSION = "soak";
const FILE = new URL("../local/soak.csv", import.meta.url);
const EXACT = ["tent pegs", "cheapest fishing rod", "gas canister", "where are the toilets", "best tent", "head torch"];
const AI = ["i want to catch some big ass fish", "something to keep the mozzies away", "what keeps beers coldest", "comfy chair for the beach"];

async function askOnce(q, dry) {
  const t0 = performance.now();
  try {
    const res = await fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ q, store: "brendale", session: SESSION, dry }) });
    let first = 0, last = null, buffer = "";
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      if (!first) first = performance.now() - t0;
      buffer += dec.decode(chunk, { stream: true });
    }
    for (const line of buffer.trim().split("\n")) last = JSON.parse(line);
    return { status: res.status, first, total: performance.now() - t0, route: last.route };
  } catch (e) {
    return { status: 0, first: 0, total: performance.now() - t0, route: String(e).slice(0, 60) };
  }
}

const end = Date.now() + HOURS * 3600000;
for (let i = 0; Date.now() < end; i++) {
  const useAi = i % AI_EVERY === 0;
  const q = useAi ? AI[(i / AI_EVERY) % AI.length] : EXACT[i % EXACT.length];
  const r = await askOnce(q, !useAi);
  appendFileSync(FILE, `${new Date().toISOString()},${useAi ? "ai" : "exact"},${r.status},${r.route},${Math.round(r.first)},${Math.round(r.total)},"${q}"\n`);
  if (useAi) await sql(`delete from questions where session = '${SESSION}'`).catch(() => {});
  await new Promise(done => setTimeout(done, EVERY_MS));
}
