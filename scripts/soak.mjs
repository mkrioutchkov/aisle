// Asks the deployed server one question at a time with real gaps between them, the way a quiet store would, and records
// how long each one took. Quick runs in a row flatter the numbers, because they keep hitting a worker that's already up
// and a connection that's already open. Removes its log rows so the store's report stays clean, and appends each result
// to local/soak.csv. With "warm", each question is asked twice, the second time after first sending what the page sends
// when a shopper touches the screen, recorded as "exact warmed" or "ai warmed", to compare the two.
//   node scripts/soak.mjs [hours] [seconds between questions] [AI on every Nth question] [warm]
import { appendFileSync } from "node:fs";
import { API, sql } from "./sb.mjs";

const HOURS = +process.argv[2] || 4, EVERY_MS = (+process.argv[3] || 300) * 1000, AI_EVERY = +process.argv[4] || 6, COMPARE = process.argv[5] === "warm", SESSION = "soak";
const WARM_LEAD_MS = 2500;
const sleep = ms => new Promise(done => setTimeout(done, ms));
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
      buffer += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (!first && (msg.type === "delta" || msg.type === "answer")) first = performance.now() - t0;
        if (msg.type === "answer") last = msg;
      }
    }
    return { status: res.status, first, total: performance.now() - t0, route: last?.route };
  } catch (e) {
    return { status: 0, first: 0, total: performance.now() - t0, route: String(e).slice(0, 60) };
  }
}

const end = Date.now() + HOURS * 3600000;
for (let i = 0; Date.now() < end; i++) {
  const step = COMPARE ? Math.floor(i / 2) : i, aiSoFar = Math.floor(step / AI_EVERY);
  const useAi = step % AI_EVERY === 0, warmed = COMPARE && i % 2 === 1;
  const q = useAi ? AI[aiSoFar % AI.length] : EXACT[(step - aiSoFar - 1) % EXACT.length];
  if (warmed) {
    const warming = fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ action: "warm", dry: true }) }).then(res => res.text()).catch(() => {});
    await sleep(WARM_LEAD_MS);
    await warming;
  }
  const r = await askOnce(q, !useAi);
  appendFileSync(FILE, `${new Date().toISOString()},${useAi ? "ai" : "exact"}${warmed ? " warmed" : ""},${r.status},${r.route},${Math.round(r.first)},${Math.round(r.total)},"${q}"\n`);
  if (useAi) await sql(`delete from questions where session = '${SESSION}'`).catch(() => {});
  await sleep(EVERY_MS);
}
