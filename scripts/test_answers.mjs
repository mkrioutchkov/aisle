// Checks the finder's answers against the catalogue, worked out independently of engine.js.
//   node scripts/test_answers.mjs            run the checks
//   node scripts/test_answers.mjs -v         also print every answer
import { readFileSync } from "node:fs";
import "../engine.js";

const DB = JSON.parse(readFileSync(new URL("../data/brendale.json", import.meta.url), "utf8"));
const verbose = process.argv.includes("-v");
const accessory = new Set(DB.accessories || []);
const kid = p => /\b(kids?|junior|youth|toddler|child|children)\b/i.test(`${p.name} ${p.cat}`);
const bayes = p => ((p.rating || 4.2) * p.reviews + 4.2 * 20) / (p.reviews + 20);

const buildStart = performance.now();
const engine0 = createAisleEngine(DB);
const buildMs = performance.now() - buildStart;

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, msg) => { if (cond) pass++; else { fail++; fails.push(msg); } };

// What each kind of question should pick, from the raw products. Deliberately its own definition of
// each kind of thing, not the engine's: its name AND its category have to say so.
function brute(match, { min = -Infinity, max = Infinity, skipKids = true } = {}) {
  const fits = typeof match === "function" ? match : p => match.test(`${p.name} ${p.cat}`);
  return DB.products.filter(p => fits(p) && !accessory.has(p.cat) && (!skipKids || !kid(p)) && p.stock > 0 && p.price >= min && p.price <= max);
}
const kind = (nameRe, catRe, notRe) => {
  const f = p => nameRe.test(p.name) && catRe.test(p.cat) && !(notRe && notRe.test(p.name));
  f.test = s => nameRe.test(s) || catRe.test(s);
  return f;
};
const best = {
  min: rows => Math.min(...rows.map(p => p.price)),
  max: rows => Math.max(...rows.map(p => p.price)),
  rating: rows => Math.max(...rows.map(bayes)),
  reviews: rows => Math.max(...rows.map(p => p.reviews)),
};
const measure = { min: p => p.price, max: p => p.price, rating: bayes, reviews: p => p.reviews };

const ADDON = /\b(tent|rod|chair|cooler|swag|kayak|bike|bag|stool) (bags?|covers?|pegs?|poles?|mats?|repair|kits?|holders?|racks?|liners?|straps?|seats?|cases?|socks?|tubes?|lights?|parts?|carriers?|stands?|ties?|cords?|ropes?|footprints?|toppers?|mattress(es)?|paddles?|tips?|butts?|handles?|oils?|grease|cleaners?|sprays?)\b/i;
const TENT = kind(/\btents?\b/i, /\btents?\b/i, ADDON), ROD = kind(/\brods?\b/i, /\brods\b/i, ADDON), COOLER = kind(/\bcoolers?\b/i, /\bcoolers?\b/i, ADDON);
const CHAIR = kind(/\b(chairs?|stools?)\b/i, /\b(chairs|stools)\b/i, ADDON), BAG = kind(/\bsleeping bags?\b/i, /\bsleeping bags\b/i, ADDON);
const KAYAK = kind(/\bkayaks?\b/i, /\bkayaks\b/i, ADDON), HEAD = kind(/\b(headlamps?|head ?torch(es)?)\b/i, /\b(headlamps|head ?torch(es)?)\b/i), SWAG = kind(/\bswags?\b/i, /\bswags\b/i, ADDON);
const BIKE = kind(/\bbikes?\b/i, /\bbikes\b/i, ADDON), BOAT = /\b(boats?)\b/i;
const RANKED = [
  // cheap, however it's said
  ["cheapest fishing rod", ROD, "min"], ["what's the cheapest rod you guys got", ROD, "min"], ["uh what's like the cheapest fishing rod", ROD, "min"],
  ["cheapest tent", TENT, "min"], ["lowest price kayak", KAYAK, "min"], ["most affordable swag", SWAG, "min"], ["budget camping chair", CHAIR, "min"],
  ["cheap sleeping bag", BAG, "min"], ["cheapest esky", COOLER, "min"], ["whats the cheapest head torch", HEAD, "min"], ["least expensive bike", BIKE, "min"],
  ["tent that's not too expensive", TENT, "min"], ["inexpensive kayak", KAYAK, "min"], ["i don't want anything expensive, just a sleeping bag", BAG, "min"],
  // dear, however it's said
  ["most expensive fishing rod", ROD, "max"], ["priciest tent", TENT, "max"], ["dearest kayak", KAYAK, "max"], ["top of the range esky", COOLER, "max"],
  ["high end sleeping bag", BAG, "max"], ["premium camping chair", kind(new RegExp("camping (chairs?|stools?)", "i"), new RegExp("(chairs|stools)", "i"), ADDON), "max"], ["what's your most expensive swag", SWAG, "max"], ["luxury tent", TENT, "max"],
  // quality and popularity
  ["best quality tent", TENT, "rating"], ["best camping chair", CHAIR, "rating"], ["highest rated head torch", HEAD, "rating"], ["top rated kayak", KAYAK, "rating"],
  ["good quality sleeping bag", BAG, "rating"], ["best esky", COOLER, "rating"], ["most popular swag", SWAG, "reviews"], ["best selling tent", TENT, "reviews"],
  // price limits
  ["tent under 200", TENT, "rating", { max: 200 }], ["camping chair under $50", CHAIR, "rating", { max: 50 }], ["head torch less than 30 bucks", HEAD, "rating", { max: 30 }],
  ["sleeping bag over 300", BAG, "rating", { min: 300 }], ["kayak between 300 and 800", KAYAK, "rating", { min: 300, max: 800 }], ["esky around 100", COOLER, "rating", { min: 80, max: 120 }],
  ["best camping chair under 100 bucks", CHAIR, "rating", { max: 100 }], ["cheapest tent over $100", TENT, "min", { min: 100 }], ["most expensive rod under $200", ROD, "max", { max: 200 }],
  ["tent under a hundred bucks", TENT, "rating", { max: 100 }],
];
for (const [q, match, kind, range] of RANKED) {
  const r = createAisleEngine(DB).route(q);
  const top = r.items?.[0]?.p;
  const rows = brute(match, range);
  if (verbose) console.log(`${q}\n   ${r.say || "(AI) " + (r.fallback?.say || "")}`);
  if (r.ai) { ok(false, `${q}: went to AI instead of being worked out`); continue; }
  if (!rows.length) { ok(/couldn't find/i.test(r.say), `${q}: nothing qualifies, should say so: ${r.say}`); continue; }
  ok(!!top, `${q}: no product: ${r.say}`);
  if (!top) continue;
  ok(match(top), `${q}: wrong kind of product: ${top.name} [${top.cat}]`);
  ok(top.stock > 0, `${q}: sold out: ${top.name}`);
  if (range) ok(top.price >= (range.min ?? -Infinity) && top.price <= (range.max ?? Infinity), `${q}: price outside limit: ${top.name} ${top.price}`);
  const want = best[kind](rows), got = measure[kind](top);
  ok(Math.abs(want - got) < 1e-9, `${q}: ${kind} should be ${want}, got ${got} (${top.name})`);
}

// Sizes and specs read from product names.
const biggest = (rows, re) => Math.max(...rows.map(p => { const m = p.name.match(re); return m ? parseFloat(m[1]) : -Infinity; }));
for (const [q, match, re] of [["biggest tent", TENT, /(\d+)\s*-?\s*v?\s*person/i], ["brightest torch", /\btorch(es)?\b/i, /(\d+)\s*lumen/i], ["brightest head torch", HEAD, /(\d+)\s*lumen/i]]) {
  const r = createAisleEngine(DB).route(q), top = r.items?.[0]?.p;
  if (verbose) console.log(`${q}\n   ${r.say || "(AI)"}`);
  const m = top && top.name.replace(/,/g, "").match(re);
  ok(m && parseFloat(m[1]) === biggest(brute(match).map(p => ({ ...p, name: p.name.replace(/,/g, "") })), re), `${q}: ${top?.name}`);
}
{
  const r = createAisleEngine(DB).route("warmest sleeping bag"), top = r.items?.[0]?.p;
  if (verbose) console.log(`warmest sleeping bag\n   ${r.say}`);
  const temp = p => { const m = p.name.match(/(-?\d+)\s*°/); return m ? parseFloat(m[1]) : Infinity; };
  ok(top && temp(top) === Math.min(...brute(BAG).map(temp)), `warmest sleeping bag: ${top?.name}`);
}

// Follow-ups keep the subject and move the right way.
{
  const e = createAisleEngine(DB);
  const say = q => { const r = e.route(q); if (r.ai) return { ...r.fallback, wentAI: true }; e.log(q, r); if (verbose) console.log(`${q}\n   ${r.say}`); return r; };
  const a = say("cheapest fishing rod").items[0].p;
  const b = say("and the most expensive?").items[0].p;
  ok(ROD.test(`${b.name} ${b.cat}`) && b.price > a.price, `"and the most expensive?" should stay on rods: ${b.name}`);
  const c = say("got anything cheaper?").items[0].p;
  ok(ROD.test(`${c.name} ${c.cat}`) && c.price < b.price, `"got anything cheaper?" should be a cheaper rod: ${c.name} ${c.price} vs ${b.price}`);
  const d = say("something else").items[0].p;
  ok(ROD.test(`${d.name} ${d.cat}`) && d.id !== c.id, `"something else" should be a different rod: ${d.name}`);
  const f = say("any better?").items[0].p;
  ok(ROD.test(`${f.name} ${f.cat}`) && bayes(f) >= bayes(d), `"any better?" should rate at least as high: ${f.name}`);
  const g = say("camping chair").items[0].p;
  const h = say("got anything cheaper?").items[0].p;
  ok(CHAIR.test(`${h.name} ${h.cat}`) && h.price < g.price, `chair then cheaper: ${g.name} ${g.price} -> ${h.name} ${h.price}`);
  const t = say("biggest tent").items[0].p;
  const u = say("anything smaller?").items[0].p;
  ok(TENT.test(`${u.name} ${u.cat}`) && u.id !== t.id, `tent then smaller: ${u.name}`);
}

// Plain lookups: the right thing first, and never a near-miss word.
for (const [q, match] of [
  ["camping chair", CHAIR], ["camping chairs", CHAIR], ["where are the camping chairs", CHAIR], ["do you have camping chairs", CHAIR], ["how much is a camping chair", CHAIR],
  ["tent pegs", /\bpegs?\b/i], ["kids sleeping bag", BAG], ["gas canister", /\b(canister|cartridge|butane|gas)/i], ["head torch", HEAD], ["fishing rod", ROD], ["esky", COOLER],
  ["do you sell boats", BOAT], ["boats", BOAT], ["kayak", KAYAK], ["rain jacket", /\brain\b/i], ["first aid kit", /first aid/i], ["hiking boots", /\b(boot|hik)/i], ["life jacket", /\b(pfd|life jacket)/i],
]) {
  const r = createAisleEngine(DB).route(q), base = r.ai ? r.fallback : r, top = base.items?.[0]?.p;
  if (verbose) console.log(`${q}\n   ${r.ai ? "(AI first) " : ""}${base.say}`);
  ok(top && match.test(`${top.name} ${top.cat}`), `${q}: led with ${top?.name} [${top?.cat}]`);
}
ok(createAisleEngine(DB).route("tell me a joke").ai, "tell me a joke should go to the AI");
for (const q of ["is this real stock?", "where are the toilets?", "returns"]) {
  const r = createAisleEngine(DB).route(q), base = r.ai ? r.fallback : r;
  if (verbose) console.log(`${q}\n   ${base.say}`);
  ok(!base.items?.length, `${q}: should not show products: ${base.items?.[0]?.p.name}`);
}

// Misheard words, as speech recognition really gets them wrong. Each should still find the right thing.
const LANTERN = /\blanterns?\b/i, LURE = /\blures?\b/i, REEL = /\breels?\b/i, PEG = /\bpegs?\b/i, BOOT = /\b(boots?|shoes?)\b/i, TACKLE = /\btackle\b/i;
for (const [q, match] of [
  ["tint", TENT], ["tints", TENT], ["camping tint", TENT], ["family tint", TENT], ["taunt", TENT], ["tent pigs", PEG], ["tint pegs", PEG], ["ten pegs", PEG], ["tentpegs", PEG],
  ["camping share", CHAIR], ["camping cheer", CHAIR], ["sleeping bug", BAG], ["sleeping back", BAG], ["sleepin bag", BAG], ["sleeping beg", BAG],
  ["fishing road", ROD], ["fishing rad", ROD], ["fishing rode", ROD], ["fishin rod", ROD], ["cheapest fishing road", ROD], ["best fishing rad", ROD],
  ["swig", SWAG], ["swagg", SWAG], ["kyack", KAYAK], ["cayak", KAYAK], ["kayack", KAYAK], ["fishing kyack", KAYAK], ["coolar", COOLER], ["eski", COOLER], ["hard colour", COOLER],
  ["lanton", LANTERN], ["camping lantin", LANTERN], ["fishing lore", LURE], ["fishing real", REEL], ["spinning real", REEL], ["hiking boats", BOOT], ["hiking boat", BOOT],
  ["tackel box", TACKLE], ["tackle bocks", TACKLE], ["hed torch", HEAD], ["gas cannister", /\b(canister|cartridge|butane|gas)/i], ["bike helmut", /\bhelmets?\b/i], ["rain jackit", /\brain\b/i],
  ["for person tent", TENT], ["to person tent", TENT], ["back pack", /\b(backpack|pack)\b/i], ["wet suit", /\bwetsuits?\b/i], ["sun glasses", /\bsunglasses\b/i],
]) {
  const r = createAisleEngine(DB).route(q, { voice: true }), base = r.ai ? r.fallback : r, top = base.items?.[0]?.p;
  if (verbose) console.log(`[voice] ${q}\n   ${r.ai ? "(AI first) " : ""}${base.say} | ${base.sub || ""}`);
  ok(top && match.test(`${top.name} ${top.cat}`), `[voice] ${q}: led with ${top?.name} [${top?.cat}]`);
}
{
  const r = createAisleEngine(DB).route("for person tent", { voice: true }), top = r.items?.[0]?.p;
  ok(top && parseInt((top.name.match(/(\d+)\s*-?\s*v?\s*person/i) || [])[1], 10) >= 4, `"for person tent" should mean 4 person: ${top?.name}`);
}
// Real words stay as they are, and small talk doesn't turn into a product.
for (const [q, match] of [["road bike", /\b(road|bike)\b/i], ["reel", REEL], ["dog life jacket", /\bdog\b/i], ["boots", BOOT], ["boats", BOAT], ["tint", TENT]]) {
  const r = createAisleEngine(DB).route(q, { voice: true }), base = r.ai ? r.fallback : r, top = base.items?.[0]?.p;
  ok(top && match.test(`${top.name} ${top.cat}`), `${q}: led with ${top?.name}`);
}
for (const q of ["thanks", "cheers mate", "tell me a joke", "what's the weather today", "do you sell pizza"]) {
  const r = createAisleEngine(DB).route(q, { voice: true }), base = r.ai ? r.fallback : r;
  if (verbose) console.log(`[voice] ${q}\n   ${r.ai ? "(AI first) " : ""}${base.say} | ${base.sub || ""}`);
  ok(!/^Showing /.test(base.sub || ""), `${q}: shouldn't be "corrected": ${base.sub}`);
}
{
  const e = createAisleEngine(DB);
  ok(TENT.test(e.bestHeard(["tint", "tent", "tin"])), `bestHeard should pick tent: ${e.bestHeard(["tint", "tent", "tin"])}`);
  ok(/fishing rod/.test(e.bestHeard(["fishing road", "fishing rod"])) || /fishing road/.test(e.bestHeard(["fishing road", "fishing rod"])), "bestHeard fishing rod");
}

// Things the browser test caught: never "corrected" into a product, and sent to the AI with the right shelf.
for (const q of ["do you price match", "are you open on sunday", "do you do afterpay", "what's your returns policy", "which is better, a swag or a tent?", "tent or swag", "what's the difference between a swag and a tent"]) {
  const r = createAisleEngine(DB).route(q);
  if (verbose) console.log(`${q}\n   ${r.ai ? "(AI first) " + r.fallback.say : r.say}`);
  ok(r.ai || /service desk/i.test(r.say || ""), `${q}: should go to the AI or the desk: ${r.say}`);
  ok(!/^Showing /.test((r.ai ? r.fallback.sub : r.sub) || ""), `${q}: shouldn't be corrected`);
}
{
  const r = createAisleEngine(DB).route("what can I get to keep my beers cold");
  ok(r.ai && r.pool.some(h => /cooler/i.test(h.p.cat)), "beers cold: AI should get coolers to choose from");
  ok(!/^Showing /.test(r.fallback.sub || ""), `beers cold shouldn't be corrected: ${r.fallback.sub}`);
  const e = createAisleEngine(DB);
  e.route("hard cooler");
  const b = e.route("got anything bigger?"), base = b.ai ? b.fallback : b;
  ok(!b.ai && /cooler/i.test(base.items?.[0]?.p.name || ""), `cooler then bigger should stay on coolers: ${base.items?.[0]?.p.name} ${b.ai ? "(went to AI)" : ""}`);
}

// Speed: the part the phone does before any network.
const QS = RANKED.map(r => r[0]);
const t0 = performance.now();
for (let i = 0; i < 20; i++) for (const q of QS) engine0.route(q);
const perQ = (performance.now() - t0) / (20 * QS.length);

console.log(`\n${DB.products.length} products | index built in ${buildMs.toFixed(0)}ms | ${perQ.toFixed(2)}ms per question on this PC`);
console.log(`${pass} passed, ${fail} failed`);
for (const f of fails) console.log("  FAIL", f);
process.exit(fail ? 1 : 0);
