// Can a shopper ask for any product by name? Picks random products and asks the deployed server for each one three ways:
// the whole name, the whole name with a word or two misheard, and most of the name with one word misheard. Counts how
// often the product reaches the AI's shelf or the direct answer. Dry, so there's no AI call and nothing is logged.
//   node scripts/test_names.mjs [how many products]
// The mishearing is simulated. It copies what real speech did to questions on a real phone: joined words split, codes
// split, vowels and similar consonants swapped.
import { randomInt } from "node:crypto";
import { API, sql } from "./sb.mjs";

const N = +process.argv[2] || 100;
const all = await sql(`select id, name from products`);
const pick = a => a[randomInt(a.length)];
const sample = new Map();
while (sample.size < N) { const p = pick(all); sample.set(p.id, p); }

const LEADS = ["", "", "i'd like the ", "do you have the ", "where's the ", "can i get a ", "i'm looking for the ", "have you got the "];
const VOWELS = { a: "o", e: "i", i: "e", o: "a", u: "a" };
const CONSONANTS = { b: "p", p: "b", d: "t", t: "d", g: "k", k: "g", v: "f", f: "v", m: "n", n: "m" };
const spoken = name => name
  .replace(/(\d+)'(\d+)"/g, "$1 foot $2").replace(/(\d+)'/g, "$1 foot").replace(/"/g, " inch").replace(/°C/g, " degree")
  .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9.\s-]/g, "").replace(/-/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
function mishear(w) {
  if (/\d/.test(w) && /[a-z]/.test(w)) return w.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");
  if (w.length < 4) return w;
  const swap = map => { const at = [...w].map((c, i) => (map[c] && i > 0 ? i : -1)).filter(i => i >= 0); return at.length ? () => { const i = pick(at); return w.slice(0, i) + map[w[i]] + w.slice(i + 1); } : null; };
  const ways = [swap(VOWELS), swap(CONSONANTS)].filter(Boolean);
  if (w.length >= 8) ways.push(() => { const i = 3 + randomInt(w.length - 5); return `${w.slice(0, i)} ${w.slice(i)}`; });
  return ways.length ? pick(ways)() : w;
}
const cases = [];
for (const p of sample.values()) {
  const full = spoken(p.name);
  cases.push({ id: p.id, name: p.name, kind: "whole", q: full.join(" ") });
  const heard = [...full], slots = heard.map((w, i) => (w.length >= 4 || /\d/.test(w) ? i : -1)).filter(i => i >= 0);
  for (let k = 0; k < Math.min(2, slots.length); k++) { const i = pick(slots); heard[i] = mishear(heard[i]); }
  cases.push({ id: p.id, name: p.name, kind: "misheard", q: pick(LEADS) + heard.join(" ") });
  const words = full.filter(w => !/\d/.test(w));
  if (words.length >= 3) {
    const part = words.slice(0, Math.max(3, Math.ceil(words.length * 0.75))), i = randomInt(part.length);
    part[i] = mishear(part[i]);
    cases.push({ id: p.id, name: p.name, kind: "part of it", q: pick(LEADS) + part.join(" ") });
  }
}

async function ask(q) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ q, voice: true, store: "brendale", dry: true, session: "test" }) });
    if (res.ok) return JSON.parse((await res.text()).trim().split("\n").pop());
    if (attempt >= 3) throw new Error(`${q}: ${res.status}`);
    await new Promise(done => setTimeout(done, 1500));
  }
}
let next = 0;
const worker = async () => {
  while (next < cases.length) {
    const c = cases[next++], r = await ask(c.q);
    const shown = r.route === "ai" ? r.pool || [] : (r.items || []).map(x => x.p || x);
    Object.assign(c, { route: r.route, rank: shown.findIndex(p => p.id === c.id), say: r.say || "" });
  }
};
await Promise.all([worker(), worker(), worker()]);

for (const kind of ["whole", "misheard", "part of it"]) {
  const k = cases.filter(c => c.kind === kind), shown = k.filter(c => c.rank >= 0).length;
  console.log(`${kind.padEnd(11)} ${k.length} asked, ${shown} shown (${Math.round(100 * shown / k.length)}%), ${k.filter(c => c.rank === 0).length} first, ${k.filter(c => c.route === "list").length} wrongly split into a list`);
}
console.log("\nNot shown. Usually a near variant, like another size of the same thing:");
for (const c of cases.filter(c => c.rank < 0)) console.log(`  ${c.kind}: "${c.q}" for "${c.name}"${c.say ? ` => ${c.say.slice(0, 70)}` : ""}`);
