// Tries questions against the deployed API and prints the answer and timing.
//   node scripts/try_api.mjs "tent pegs" "cheapest tent"
//   node scripts/try_api.mjs --live "what should I wear in the rain"   (live also calls the AI)
import { API } from "./sb.mjs";

const args = process.argv.slice(2), live = args.includes("--live"), rounds = args.includes("--twice") ? 2 : 1;
const qs = args.filter(a => !a.startsWith("--"));
for (let round = 0; round < rounds; round++) {
  for (const q of qs) {
    const t = performance.now();
    const res = await fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ q, store: "brendale", voice: true, dry: !live, session: "try" }) });
    let firstAt = 0, buffer = "", text = "", last = null;
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "delta") { if (!firstAt) firstAt = performance.now() - t; text += ev.text; }
        else last = ev;
      }
    }
    if (buffer.trim()) last = JSON.parse(buffer);
    const total = performance.now() - t, a = last || {};
    if (rounds > 1 && round === 0) continue;
    const shown = (a.items || []).slice(0, 3).map(i => i.p.name.slice(0, 32)).join(" / ");
    const pool = a.pool ? `pool ${a.pool.length}${a.strong ? "" : " (would plan)"}: ${a.pool.slice(0, 3).map(p => p.name.slice(0, 24)).join(" / ")}` : "";
    console.log(`${total.toFixed(0).padStart(5)}ms${firstAt ? ` first ${firstAt.toFixed(0)}ms` : ""} server ${a.timing?.server_ms ?? "?"}ms ${JSON.stringify(a.timing || {}).includes("plan_ms") ? `plan ${a.timing.plan_ms}ms ` : ""}[${a.route}] ${q}\n      => ${a.say || pool || JSON.stringify(a).slice(0, 200)}${a.sub ? ` | ${a.sub}` : ""}${shown ? `\n      cards: ${shown}` : ""}`);
  }
}
