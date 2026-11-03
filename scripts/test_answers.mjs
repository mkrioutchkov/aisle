// Checks answers from the deployed server against the database, worked out independently of the server's logic.
//   node scripts/test_answers.mjs            run the checks
//   node scripts/test_answers.mjs -v         also print every answer
import { BASE, API, secretKey } from "./sb.mjs";
import { createEngine } from "../supabase/functions/api/engine.mjs";

const verbose = process.argv.includes("-v");
const key = await secretKey();
async function rest(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` } });
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const [products, placements, categories] = await Promise.all([
  rest("products?select=id,name,cat,price,rating,reviews,acc,kids"),
  rest("placements?select=product_id,aisle,bay,stock&store=eq.brendale"),
  rest("categories?select=name,accessory"),
]);
const here = new Map(placements.map(p => [p.product_id, p]));
const DB = products.map(p => ({ ...p, price: +p.price, rating: p.rating == null ? null : +p.rating, ...here.get(p.id) }));
const accessory = new Set(categories.filter(c => c.accessory).map(c => c.name));
const kid = p => /\b(kids?|junior|youth|toddler|child|children)\b/i.test(`${p.name} ${p.cat}`);
const bayes = p => ((p.rating || 4.2) * p.reviews + 4.2 * 20) / (p.reviews + 20);

let pass = 0, fail = 0, slowest = 0, calls = 0, totalMs = 0;
const fails = [], stamps = [];
const ok = (cond, msg) => { if (cond) pass++; else { fail++; fails.push(msg); } };

// The phone's request. Returns the answer; `ai` is true if the server would send it to the AI.
async function ask(q, opts = {}) {
  const t = performance.now();
  const res = await fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ q, store: "brendale", dry: true, session: "test", ...opts }) });
  const text = await res.text();
  const ms = performance.now() - t;
  calls++; totalMs += ms; slowest = Math.max(slowest, ms); stamps.push(ms);
  if (!res.ok) throw new Error(`${q}: ${res.status} ${text.slice(0, 200)}`);
  const a = JSON.parse(text.trim().split("\n").pop());
  a.ai = a.route === "ai";
  // Rankings and corrections go to the AI with the plain answer as its fallback. That answer is what these checks read,
  // and the AI's sorted list starts with what it found.
  if (a.ai && (a.fallback?.items?.length || a.fallback?.route === "exact")) {
    const sentAs = a.q, order = a.order, pool = a.pool;
    Object.assign(a, a.fallback, { ai: false, viaAi: true, sentAs, order, pool });
  }
  a.top = a.items?.[0]?.p ?? a.pool?.[0];
  if (verbose) console.log(`${opts.voice ? "[voice] " : ""}${q}\n   ${a.ai ? `(AI, ${a.strong ? "shelf" : "plan"}) ${(a.pool || []).slice(0, 2).map(p => p.name).join(" / ")}` : a.say} | ${a.sub || ""}`);
  return a;
}

// What each kind of question should pick, from the raw products. Deliberately its own definition of
// each kind of thing, not the server's: its name AND its category have to say so.
function brute(match, { min = -Infinity, max = Infinity, skipKids = true } = {}) {
  const fits = typeof match === "function" ? match : p => match.test(`${p.name} ${p.cat}`);
  return DB.filter(p => fits(p) && !accessory.has(p.cat) && (!skipKids || !kid(p)) && p.stock > 0 && p.price >= min && p.price <= max);
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
const measure = { min: p => +p.price, max: p => +p.price, rating: p => +p.bayes, reviews: p => +p.reviews };

const ADDON = /\b(tent|rod|chair|cooler|swag|kayak|bike|bag|stool) (bags?|covers?|pegs?|poles?|mats?|repair|kits?|holders?|racks?|liners?|straps?|seats?|cases?|socks?|tubes?|lights?|parts?|carriers?|stands?|ties?|cords?|ropes?|footprints?|toppers?|mattress(es)?|paddles?|tips?|butts?|handles?|oils?|grease|cleaners?|sprays?)\b/i;
const TENT = kind(/\btents?\b/i, /\btents?\b/i, ADDON), ROD = kind(/\brods?\b/i, /\brods\b/i, ADDON), COOLER = kind(/\bcoolers?\b/i, /\bcoolers?\b/i, ADDON);
const CHAIR = kind(/\b(chairs?|stools?)\b/i, /\b(chairs|stools)\b/i, ADDON), BAG = kind(/\bsleeping bags?\b/i, /\bsleeping bags\b/i, ADDON);
const KAYAK = kind(/\bkayaks?\b/i, /\bkayaks\b/i, ADDON), HEAD = kind(/\b(headlamps?|head ?torch(es)?)\b/i, /\b(headlamps|head ?torch(es)?)\b/i), SWAG = kind(/\bswags?\b/i, /\bswags\b/i, ADDON);
const BIKE = kind(/\bbikes?\b/i, /\bbikes\b/i, ADDON), BOAT = /\b(boats?)\b/i;
const has = (want, p) => (typeof want === "function" ? want(p) : want.test(`${p.name} ${p.cat}`));
const RANKED = [
  // cheap, however it's said
  ["cheapest fishing rod", ROD, "min"], ["what's the cheapest rod you guys got", ROD, "min"], ["uh what's like the cheapest fishing rod", ROD, "min"],
  ["cheapest tent", TENT, "min"], ["lowest price kayak", KAYAK, "min"], ["most affordable swag", SWAG, "min"], ["budget camping chair", CHAIR, "min"],
  ["cheap sleeping bag", BAG, "min"], ["cheapest esky", COOLER, "min"], ["whats the cheapest head torch", HEAD, "min"], ["least expensive bike", BIKE, "min"],
  ["tent that's not too expensive", TENT, "min"], ["inexpensive kayak", KAYAK, "min"], ["i don't want anything expensive, just a sleeping bag", BAG, "min"],
  // dear, however it's said
  ["most expensive fishing rod", ROD, "max"], ["priciest tent", TENT, "max"], ["dearest kayak", KAYAK, "max"], ["top of the range esky", COOLER, "max"],
  ["high end sleeping bag", BAG, "max"], ["premium camping chair", kind(/camping (chairs?|stools?)/i, /(chairs|stools)/i, ADDON), "max"], ["what's your most expensive swag", SWAG, "max"], ["luxury tent", TENT, "max"],
  // quality and popularity
  ["best quality tent", TENT, "rating"], ["best camping chair", CHAIR, "rating"], ["highest rated head torch", HEAD, "rating"], ["top rated kayak", KAYAK, "rating"],
  ["good quality sleeping bag", BAG, "rating"], ["best esky", COOLER, "rating"], ["most popular swag", SWAG, "reviews"], ["best selling tent", TENT, "reviews"],
  // price limits
  ["tent under 200", TENT, "rating", { max: 200 }], ["camping chair under $50", CHAIR, "rating", { max: 50 }], ["head torch less than 30 bucks", HEAD, "rating", { max: 30 }],
  ["sleeping bag over 300", BAG, "rating", { min: 300 }], ["kayak between 300 and 800", KAYAK, "rating", { min: 300, max: 800 }], ["esky around 100", COOLER, "rating", { min: 80, max: 120 }],
  ["best camping chair under 100 bucks", CHAIR, "rating", { max: 100 }], ["cheapest tent over $100", TENT, "min", { min: 100 }], ["most expensive rod under $200", ROD, "max", { max: 200 }],
  ["tent under a hundred bucks", TENT, "rating", { max: 100 }],
];
for (const [q, match, how, range] of RANKED) {
  const r = await ask(q), top = r.items?.[0]?.p, rows = brute(match, range);
  if (r.ai) { ok(false, `${q}: went to AI instead of being worked out`); continue; }
  if (!rows.length) { ok(/couldn't find/i.test(r.say), `${q}: nothing qualifies, should say so: ${r.say}`); continue; }
  ok(!!top, `${q}: no product: ${r.say}`);
  if (!top) continue;
  ok(has(match, { ...top, price: +top.price }), `${q}: wrong kind of product: ${top.name} [${top.cat}]`);
  ok(top.stock > 0, `${q}: sold out: ${top.name}`);
  if (range) ok(top.price >= (range.min ?? -Infinity) && top.price <= (range.max ?? Infinity), `${q}: price outside limit: ${top.name} ${top.price}`);
  const want = best[how](rows), got = measure[how](top);
  ok(Math.abs(want - got) < 1e-3, `${q}: ${how} should be ${want}, got ${got} (${top.name})`);
}

// Sizes and specs read from product names.
const biggest = (rows, re) => Math.max(...rows.map(p => { const m = p.name.replace(/,/g, "").match(re); return m ? parseFloat(m[1]) : -Infinity; }));
for (const [q, match, re] of [["biggest tent", TENT, /(\d+)\s*-?\s*v?\s*person/i], ["brightest torch", /\btorch(es)?\b/i, /(\d+)\s*lumen/i], ["brightest head torch", HEAD, /(\d+)\s*lumen/i]]) {
  const r = await ask(q), top = r.items?.[0]?.p, m = top && top.name.replace(/,/g, "").match(re);
  ok(m && parseFloat(m[1]) === biggest(brute(match), re), `${q}: ${top?.name}`);
}
{
  const r = await ask("warmest sleeping bag"), top = r.items?.[0]?.p;
  const temp = p => { const m = p.name.match(/(-?\d+)\s*°/); return m ? parseFloat(m[1]) : Infinity; };
  ok(top && temp(top) === Math.min(...brute(BAG).map(temp)), `warmest sleeping bag: ${top?.name}`);
}

// Follow-ups keep the subject and move the right way. The phone carries `ctx` from one answer to the next.
{
  let ctx = null;
  const say = async q => { const r = await ask(q, { ctx }); if (r.ctx) ctx = r.ctx; return r; };
  const a = (await say("cheapest fishing rod")).items[0].p;
  const b = (await say("and the most expensive?")).items[0].p;
  ok(has(ROD, b) && b.price > a.price, `"and the most expensive?" should stay on rods: ${b.name}`);
  const c = (await say("got anything cheaper?")).items[0].p;
  ok(has(ROD, c) && c.price < b.price, `"got anything cheaper?" should be a cheaper rod: ${c.name} ${c.price} vs ${b.price}`);
  const d = (await say("something else")).items[0].p;
  ok(has(ROD, d) && d.id !== c.id, `"something else" should be a different rod: ${d.name}`);
  const better = await say("any better?"), f = better.items?.[0]?.p;
  ok(f ? has(ROD, f) && +f.bayes >= +d.bayes : /already the top rated/.test(better.say), `"any better?" should rate at least as high: ${f?.name || better.say}`);
  ctx = null;
  const g = (await say("camping chair")).items[0].p;
  const h = (await say("got anything cheaper?")).items[0].p;
  ok(has(CHAIR, h) && h.price < g.price, `chair then cheaper: ${g.name} ${g.price} -> ${h.name} ${h.price}`);
  ctx = null;
  const t = (await say("biggest tent")).items[0].p;
  const u = (await say("anything smaller?")).items[0].p;
  ok(has(TENT, u) && u.id !== t.id, `tent then smaller: ${u.name}`);
  ctx = null;
  await say("hard cooler");
  const big = await say("got anything bigger?");
  ok(!big.ai && (/cooler|icebox/i.test(big.items?.[0]?.p.name || "") || /already the biggest/.test(big.say)), `cooler then bigger should stay on coolers: ${big.items?.[0]?.p.name || big.say}`);
  // After an AI answer the AI takes the follow-up, and it's only offered products that really are cheaper.
  const rec = DB.filter(p => has(ROD, p) && p.stock > 0 && p.price > 100).sort((x, y) => x.price - y.price)[0];
  const fromAi = { fromAi: true, about: "", cat: rec.cat, label: rec.cat.toLowerCase(), kidsOk: false, persons: null, top: { id: rec.id, price: rec.price, bayes: bayes(rec), size: null, name: rec.name, cat: rec.cat }, shown: [rec.id] };
  const cheaper = await ask("got anything cheaper?", { ctx: fromAi });
  ok(cheaper.ai && cheaper.strong && cheaper.pool.length > 0 && cheaper.pool.every(p => p.cat === rec.cat && +p.price < rec.price && p.id !== rec.id), `after AI, cheaper should offer the AI only cheaper ${rec.cat}: ${(cheaper.pool || []).map(p => `${p.name} ${p.price}`).join(", ")}`);
  const cheapest = DB.filter(p => p.cat === rec.cat && p.stock > 0).sort((x, y) => x.price - y.price)[0];
  const none = await ask("got anything cheaper?", { ctx: { ...fromAi, top: { ...fromAi.top, id: cheapest.id, price: cheapest.price } } });
  ok(none.ai && none.strong && !none.pool.some(p => +p.price >= cheapest.price), `after AI, nothing cheaper should offer nothing dearer: ${(none.pool || []).map(p => `${p.name} ${p.price}`).join(", ")}`);
}

// Plain lookups: answered straight away, the right thing first, never a near-miss word.
for (const [q, match] of [
  ["tent", TENT], ["tents", TENT], ["camping chair", CHAIR], ["camping chairs", CHAIR], ["where are the camping chairs", CHAIR], ["do you have camping chairs", CHAIR], ["how much is a camping chair", CHAIR],
  ["tent pegs", /\bpegs?\b/i], ["kids sleeping bag", BAG], ["gas canister", /\b(canister|cartridge|butane|gas)/i], ["head torch", HEAD], ["fishing rod", ROD], ["esky", COOLER],
  ["do you sell boats", BOAT], ["boats", BOAT], ["kayak", KAYAK], ["rain jacket", /\brain\b/i], ["first aid kit", /first aid/i], ["hiking boots", /\b(boot|hik)/i], ["life jacket", /\b(pfd|life jacket)/i],
  ["sunscreen", /\b(sunscreen|spf)\b/i], ["do you have a gopro", /\b(gopro|action|camera)/i], ["tinny", BOAT],
]) {
  const r = await ask(q), top = r.items?.[0]?.p;
  ok(!r.ai, `${q}: exact product words should answer straight away, not go to the AI`);
  ok(top && has(match, top), `${q}: led with ${top?.name} [${top?.cat}]`);
}

// Max's rule: exact terms are instant, everything else goes to the AI.
for (const q of ["i want to catch some big ass fish", "what should I wear in the rain", "something to stop the kids getting sunburnt", "which tent for a family of 4 under 500 bucks?", "I need a comfy chair for my bad back",
  "what's warmer, down or synthetic?", "good tent for two people and a dog", "how do I keep mozzies away", "do you price match", "are you open on sunday", "tell me a joke", "thanks", "is a swag better than a tent",
  "what's the difference between a swag and a tent", "tent or swag", "best camping chair for my bad back", "what do I need to go crabbing", "what gas fits a coleman stove", "my son is 8, what bike should he get"]) {
  const r = await ask(q);
  ok(r.ai, `${q}: should go to the AI, got: ${r.say}`);
  ok(!/^Showing /.test(r.note || ""), `${q}: shouldn't be corrected: ${r.note}`);
}
{
  const r = await ask("what can I get to keep my beers cold");
  ok(r.ai && r.pool.some(p => /cooler/i.test(p.cat)), "beers cold: AI should get coolers to choose from");
  const mozzies = await ask("how do I keep mozzies away");
  ok(mozzies.pool.some(p => /repellent|aerogard|mosquito|mozzie/i.test(p.name)), `mozzies: AI should get repellent: ${mozzies.pool.slice(0, 3).map(p => p.name)}`);
  const sun = await ask("something to stop the kids getting sunburnt");
  ok(sun.pool.some(p => /sunscreen|spf/i.test(p.name)), `sunburn: AI should get sunscreen: ${sun.pool.slice(0, 3).map(p => p.name)}`);
  const choice = await ask("which is better, a swag or a tent?");
  ok(choice.pool.some(p => has(SWAG, p)) && choice.pool.some(p => has(TENT, p)), `swag or tent: AI should get both: ${choice.pool.slice(0, 4).map(p => p.name)}`);
  const big = await ask("i want to catch some big ass fish");
  ok(big.pool.some(p => /rod|reel|combo/i.test(p.name)), `big fish: AI should get fishing gear: ${big.pool.slice(0, 3).map(p => p.name)}`);
}

// Several things at once, by voice, with or without joins, in walking order.
const HOOK = /\bhooks?\b/i, SUN = /\b(sunscreen|spf|sun)\b/i, STOVE = /\bstoves?\b/i, GASP = /\b(gas|butane|propane)\b/i, LINE = /\b(line|braid|mono)\b/i, REEL = /\breels?\b/i;
for (const [q, wants] of [
  ["i want a fishing hook, attempt, a fishing rod, and sunscreen", [HOOK, TENT, ROD, SUN]],
  ["i want a fishing hook attempt a fishing rod and sunscreen", [HOOK, TENT, ROD, SUN]],
  ["i want a fishing hook, a tent, a fishing rod, and sunscreen", [HOOK, TENT, ROD, SUN]],
  ["I need a tent a sleeping bag and a head torch", [TENT, BAG, HEAD]],
  ["tent fishing rod sunscreen", [TENT, ROD, SUN]],
  ["do you have tents and sleeping bags", [TENT, BAG]],
  ["where are the kayaks and the life jackets", [KAYAK, /\b(pfd|life jacket)/i]],
  ["a tent, a stove and some gas", [TENT, STOVE, GASP]],
  ["fishing rod, reel and line", [ROD, REEL, LINE]],
  ["cheapest tent and the best sleeping bag", [TENT, BAG]],
  ["um a tint and a fishing road please", [TENT, ROD]],
]) {
  const r = await ask(q, { voice: true }), rows = r.items || [];
  ok(!r.ai && rows.length === wants.length, `[list] ${q}: expected ${wants.length} items, got ${rows.length}: ${r.say || "(AI)"}`);
  for (const want of wants) ok(rows.some(x => has(want, x.p)), `[list] ${q}: missing ${want}: ${rows.map(x => x.p.name)}`);
  const aisles = rows.map(x => x.p.aisle);
  ok(aisles.every((n, i) => !i || aisles[i - 1] <= n), `[list] ${q}: not in walking order: ${aisles}`);
}
// One thing, even with "and" or "a" in it.
for (const q of ["rod and reel combo", "tent for a family of 4", "do you have a tent", "where can i find a fishing rod", "a tent", "sleeping bag", "tents", "cheapest tent for a family of 5", "camping table", "which is better a tent or a swag"]) {
  const r = await ask(q, { voice: true });
  ok(!r.walk, `${q}: shouldn't be treated as a list: ${r.say}`);
}

// Misheard words, as speech recognition really gets them wrong. Each should still find the right thing.
const LANTERN = /\blanterns?\b/i, LURE = /\blures?\b/i, PEG = /\bpegs?\b/i, BOOT = /\b(boots?|shoes?)\b/i, TACKLE = /\btackle\b/i;
for (const [q, match] of [
  ["tint", TENT], ["tints", TENT], ["camping tint", TENT], ["family tint", TENT], ["taunt", TENT], ["tent pigs", PEG], ["tint pegs", PEG], ["ten pegs", PEG], ["tentpegs", PEG],
  ["camping share", CHAIR], ["camping cheer", CHAIR], ["sleeping bug", BAG], ["sleeping back", BAG], ["sleepin bag", BAG], ["sleeping beg", BAG],
  ["fishing road", ROD], ["fishing rad", ROD], ["fishing rode", ROD], ["fishin rod", ROD], ["cheapest fishing road", ROD], ["best fishing rad", ROD],
  ["facing road", ROD], ["can you find me facing road", ROD], ["facing rod", ROD], ["facing line", LINE], ["facing reel", REEL],
  ["swig", SWAG], ["swagg", SWAG], ["kyack", KAYAK], ["cayak", KAYAK], ["kayack", KAYAK], ["fishing kyack", KAYAK], ["coolar", COOLER], ["eski", COOLER], ["hard colour", COOLER],
  ["lanton", LANTERN], ["camping lantin", LANTERN], ["fishing lore", LURE], ["fishing real", REEL], ["spinning real", REEL], ["hiking boats", BOOT], ["hiking boat", BOOT],
  ["tackel box", TACKLE], ["tackle bocks", TACKLE], ["hed torch", HEAD], ["gas cannister", /\b(canister|cartridge|butane|gas)/i], ["bike helmut", /\bhelmets?\b/i], ["rain jackit", /\brain\b/i],
  ["for person tent", TENT], ["to person tent", TENT], ["back pack", /\b(backpack|pack)\b/i], ["wet suit", /\bwetsuits?\b/i], ["sun glasses", /\bsunglasses\b/i],
]) {
  const r = await ask(q, { voice: true }), top = r.top;
  ok(top && has(match, top), `[voice] ${q}: led with ${top?.name} [${top?.cat}]${r.ai ? " (AI)" : ""}`);
}
{
  const r = await ask("for person tent", { voice: true }), top = r.items?.[0]?.p;
  ok(top && parseInt((top.name.match(/(\d+)\s*-?\s*v?\s*person/i) || [])[1], 10) >= 4, `"for person tent" should mean 4 person: ${top?.name}`);
}
// Sounding like something isn't enough: these are real requests the store can't place, and only the AI can say so.
for (const q of ["facing the road", "dog boots", "bear spray", "snow chains", "kayak hire", "gas bottle refill", "tent repair service", "rod repair", "bait freezer", "electric bike battery", "going camping in winter what sleeping bag do i need", "do you have size 10 hiking boots", "can i speak to someone"]) {
  const r = await ask(q, { voice: true });
  ok(r.ai && !/Showing/.test(r.note || ""), `${q}: should go to the AI as heard: ${r.say || r.note}`);
}
// When nothing has every word, the AI still gets the kind of product that was asked about, without a slow planning step.
for (const [q, want] of [["what size wetsuit do i need", /wetsuit/i], ["is the coleman tent waterproof", /coleman/i], ["what's the best kayak for a beginner", /kayak/i], ["do you have size 10 hiking boots", /boots?/i], ["i need something to stop my feet getting wet", /boots?|socks?/i]]) {
  const r = await ask(q, { voice: true });
  ok(r.ai && r.strong && r.pool.some(p => want.test(`${p.name} ${p.cat}`)), `${q}: AI should get ${want}: ${(r.pool || []).slice(0, 4).map(p => p.name)}`);
}
// Nothing to search for means no search and no planning step.
for (const q of ["hi", "who are you", "what can you do"]) {
  const r = await ask(q);
  ok(r.ai && r.strong && !r.pool.length, `${q}: shouldn't search for anything: ${(r.pool || []).slice(0, 2).map(p => p.name)}`);
}
// Asked for by name, with some of it misheard or run together differently. The first two are what a real phone heard.
for (const [q, name] of [
  ["I'd like the X so x gear sound extreme XES 08i subwoofer", /SoundExtreme xES08I Subwoofer/],
  ["I like the two pack of the Triton white wine glass", /Tritan White Wine Glass 2 Pack/],
  ["sea to summit frontier long handle cutlery set", /Frontier Long Handle Cutlery Set/],
  ["shimano dyna flare spin rod", /Dynaflare/],
  ["columbia back bowl full zip fleece jacket", /Backbowl/],
  ["min kota remote cradle", /Minn Kota Remote Cradle/],
  ["jetboil crunch it", /CrunchIt/],
  ["eco flow river 3 max 600w power station", /EcoFlow River 3 Max/],
  ["seaflo manual bilge pump", /Seaflo Manual Bilge Pump/],
  ["garmin gt52hw tm", /^Garmin GT52HW-TM$/],
]) {
  const r = await ask(q, { voice: true });
  const shown = r.pool || (r.items || []).map(x => x.p);
  ok(shown.some(p => name.test(p.name)), `${q}: shows ${shown.slice(0, 3).map(p => p.name).join(" / ")}`);
}
for (const q of ["subwoofer for my boat", "my brother reckons you have got some sort of subwoofer"]) {
  const r = await ask(q, { voice: true });
  ok((r.pool || []).some(p => /subwoofer/i.test(p.name)), `${q}: subwoofer should reach the AI`);
}
// One product, however many product words are in its name: not a shopping list.
for (const [q, name] of [
  ["columbia womens pfg bahama ii long sleeve shirt", /Bahama II/],
  ["the north face mens box nse pullover hoodie", /Box NSE/i],
  ["garmin navionics vision marine chart", /Navionics/],
  ["fuel stand up paddleboard back rest", /Back ?rest/i],
]) {
  const r = await ask(q, { voice: true });
  ok(r.route !== "list" && name.test(r.top?.name || ""), `${q}: ${r.route}, starts with ${r.top?.name}`);
}
// "toilets" is a place in the store, and "camping toilet" is a product.
for (const [q, where] of [["where are the toilets", /Toilets are/], ["i need to use the toilet", /Toilets are/], ["toilets", /Toilets are/], ["where's the nearest toilet", /Toilets are/], ["where are the trolleys", /Trolleys and baskets/], ["shopping trolley", /Trolleys and baskets/], ["basket", /Trolleys and baskets/], ["where do i collect my order", /Click & Collect/], ["can i get a refund", /service desk/]]) {
  const r = await ask(q);
  ok(r.route === "fact" && where.test(r.say), `${q}: ${r.route}: ${r.say}`);
}
for (const [q, name] of [["camping toilet", /toilet/i], ["portable toilet", /toilet/i], ["do you sell toilets", /toilet/i], ["how much is a toilet", /toilet/i], ["beach trolley", /beach trolley/i], ["do you have a beach trolley", /beach trolley/i], ["grill basket", /grill basket/i], ["laundry basket", /laundry basket/i]]) {
  const r = await ask(q);
  ok(r.route === "exact" && name.test(r.top?.name || ""), `${q}: ${r.route}: ${r.say}`);
}
// However the sentence starts, none of it is a product: "after" isn't "a filter", "gimme" isn't a game.
for (const [q, match] of [["i'd like a tent", TENT], ["I'd like some hiking boots", /boot/i], ["i'm after a tent", TENT], ["im chasing a tent", TENT], ["gimme a tent", TENT], ["i'll have a tent", TENT], ["i'll take a tent", TENT], ["after a tent", TENT], ["we're after a fishing rod", ROD], ["alright i want a tent", TENT], ["anyway i need a tent", TENT], ["give me a tent", TENT], ["any chance you have a tent", TENT], ["g'day i'm after a fishing rod", ROD]]) {
  const r = await ask(q, { voice: true });
  ok(r.route === "exact" && match.test(r.top?.name || ""), `${q}: ${r.route}: ${r.say || r.top?.name}`);
}
// "fishing rod" is after a rod, not a Fishing Rod Holder that reads like it.
for (const q of ["help me find a fishing rod", "i need to get a fishing rod", "where would i find a fishing rod", "can you help me find a fishing rod"]) {
  const r = await ask(q, { voice: true });
  ok(ROD.test(r.top?.name || "") && !/holder/i.test(r.top?.name || ""), `${q}: starts with ${r.top?.name}`);
}
// An s for sh only counts when it makes a real product phrase, and never beats the usual correction.
{
  const r = await ask("beach shed", { voice: true });
  ok(/shade/i.test(r.say || ""), `beach shed: should be beach shade: ${r.say || "(AI)"}`);
}
// Real words stay as they are, and small talk doesn't turn into a product.
for (const [q, match] of [["road bike", /\b(road|bike)\b/i], ["reel", REEL], ["dog life jacket", /\bdog\b/i], ["boots", BOOT], ["boats", BOAT]]) {
  const r = await ask(q, { voice: true });
  ok(r.top && has(match, r.top), `${q}: led with ${r.top?.name}`);
}
for (const q of ["thanks", "cheers mate", "tell me a joke", "what's the weather today", "do you sell pizza"]) {
  const r = await ask(q, { voice: true });
  ok(!/^Showing /.test(r.sub || r.note || ""), `${q}: shouldn't be "corrected": ${r.sub || r.note}`);
}
for (const [q, wording] of [["pocket knife", /pocket knives/], ["first aid", /first aid in/], ["toilet paper", /toilet paper in/]]) {
  const r = await ask(q);
  ok(wording.test(r.say || ""), `${q}: wording: ${r.say}`);
}
{
  const pick = async alts => { const res = await fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ q: alts[0], alts, store: "brendale", dry: true }) }); const a = JSON.parse((await res.text()).trim().split("\n").pop()); return a.heard; };
  ok(/tent/.test(await pick(["tint", "tent", "tin"])), "the speech service's other guesses should be used: tint, tent");
}

// What's on the shelf can't be wrong just because the AI tagged it: only products its answer really talks about count.
{
  const engine = createEngine({}, { words: new Map(), wordList: [], aisles: [], stores: [], pairs: new Set(), storeName: s => s }, "brendale");
  const jacket = { id: 1, name: "Cape Men's Eco Lite Down Jacket", cat: "Jackets", price: 89.99, aisle: 22, bay: 3, stock: 5 };
  const kayak = { id: 2, name: "Seaflo Adult Kayak", cat: "Kayaks", price: 199, aisle: 14, bay: 10, stock: 5 };
  const picked = raw => engine.aiAnswer(raw, [jacket, kayak], "q").items.map(i => i.p.id);
  const same = (raw, want) => ok(JSON.stringify(picked(raw)) === JSON.stringify(want), `AI tags: ${raw} gave ${picked(raw)}, wanted ${want}`);
  same("I couldn't find snow chains, sorry. Try the service desk. [[1]]", []);
  same("I can't find snow jackets, sorry. [[1]]", []);
  same("I couldn't find that, but the Seaflo Adult Kayak is $199, Aisle 14, Bay 10. [[2]]", [2]);
  same("The Seaflo is a solid buy. [[2]]", [2]);
  same("Try the Seaflo Adult Kayak at $199, Aisle 14, Bay 10.", [2]);
  same("Sunscreen helps with that. [[1]]", []);
  same("Happy to help. [[]]", []);
  ok(!engine.aiAnswer("I couldn't find it. [[1]]", [jacket], "q").ok, "an answer with no product shown isn't logged as answered");
}
for (const q of ["are the prices real", "is the stock real", "are these products real", "is this real"]) {
  const r = await ask(q);
  ok(r.route === "fact" && /prices are real/.test(r.say), `${q}: should get the fixed answer: ${r.say || "(AI)"}`);
}

// The examples printed on the sign and shown on the welcome screen: these get tried first, so they must be right.
{
  const tops = (r, n = 4) => (r.items || []).slice(0, n).map(i => i.p);
  const pegs = await ask("tent pegs"), bags = await ask("kids sleeping bag"), gas = await ask("gas canister"), torch = await ask("head torch"), rod = await ask("cheapest fishing rod"), loo = await ask("where are the toilets?"), kit = await ask("camping weekend for 4");
  ok(tops(pegs).every(p => /\bpegs?\b/i.test(p.name)), `tent pegs: ${tops(pegs).map(p => p.name)}`);
  ok(tops(bags).every(p => /\b(kids?|junior|youth)\b/i.test(p.name + " " + p.cat) && /sleeping bag/i.test(p.name)), `kids sleeping bag: ${tops(bags).map(p => p.name)}`);
  ok(tops(gas).every(p => /\b(butane|propane|gas)\b/i.test(p.name) && /\b(cartridge|canister|cylinder|bottle)s?\b/i.test(p.name)), `gas canister: ${tops(gas).map(p => p.name)}`);
  ok(!/Aisle (15|20)\b/.test(gas.say), `gas canister scattered: ${gas.say}`);
  ok(tops(torch).every(p => /\b(headlamps?|head ?torch(es)?)\b/i.test(p.name)), `head torch: ${tops(torch).map(p => p.name)}`);
  ok(has(ROD, tops(rod, 1)[0] || { name: "", cat: "" }), `cheapest fishing rod: ${tops(rod, 1)[0]?.name}`);
  ok(/toilets/i.test(loo.say) && loo.zone === "toilets", `toilets: ${loo.say}`);
  ok(/starter list for 4/.test(kit.say) && kit.items.length >= 7, `camping weekend for 4: ${kit.say}`);
  for (const [q, re] of [["what should I bring on a fishing trip", /fishing starter list/], ["first time camping with 2 kids", /camping starter list for 4/], ["tent for a camping weekend", /tent/i]]) {
    const r = await ask(q);
    ok(re.test(r.say || r.top?.name || ""), `${q}: ${r.say || "(AI)"}`);
  }
}

// The AI judges rankings and corrections. It needs the real thing on its list, whatever sorts ahead of it.
{
  for (const [q, order, real] of [
    ["cheapest pizza oven", "cheapest first", /Pizza Oven$/], ["cheapest backpack", "cheapest first", /Pack\b/], ["cheapest fridge", "cheapest first", /Fridge/],
    ["cheapest chair", "cheapest first", /Chair$/], ["cheapest gazebo", "cheapest first", /Gazebo$/], ["dearest tent", "dearest first", /Tent/], ["best tent", "highest rated first", /Tent/],
  ]) {
    const r = await ask(q);
    ok(r.viaAi && r.order === order, `${q}: should reach the AI (${order}): ${r.route} ${r.order}`);
    ok((r.pool || []).length <= 18 && (r.pool || []).some(p => real.test(p.name)), `${q}: nothing real on its list: ${(r.pool || []).map(p => p.name).slice(0, 4)}`);
    const prices = (r.pool || []).map(p => +p.price);
    if (order === "cheapest first") ok(prices.every((p, i) => !i || prices[i - 1] <= p), `${q}: list isn't in price order`);
    ok(r.top && r.say && /Checked all/.test(r.note || ""), `${q}: should keep the plain answer and its count: ${r.say} ${r.note}`);
  }
  for (const [q, sentAs] of [["i want a tint", "i want a {tint:tent}"], ["fishing real", "fishing {real:reel}"], ["facing road", "{facing:fishing} {road:rod}"]]) {
    const r = await ask(q, { voice: true });
    ok(r.viaAi && r.sentAs === sentAs, `${q}: should reach the AI as ${sentAs}: ${r.route} ${r.sentAs}`);
    ok(/^Showing /.test(r.sub || ""), `${q}: its plain answer should say what it corrected: ${r.sub}`);
  }
  // In a list there's no AI to ask, so a correction there still goes straight through.
  const list = await ask("a tint and a fishing rod", { voice: true });
  ok(list.route === "list" && list.items.length === 2, `a tint and a fishing rod: ${list.route} ${list.say}`);
  // Plain words stay direct, and so does a word that's now just filler.
  for (const q of ["tent", "tent pegs", "head torch", "jumper", "do you sell boats"]) {
    const r = await ask(q);
    ok(r.route === "exact" && !r.viaAi, `${q}: should stay direct: ${r.route}`);
  }
  const rod = await ask("cheapest fishing rod");
  const even = await ask("anything even cheaper", { ctx: rod.ctx });
  ok(!/oven/i.test(`${even.say} ${even.sub} ${even.sentAs}`), `anything even cheaper: ${even.say || even.sentAs}`);
}

// A complaint about the price wants something cheaper than what was just shown, never the dearest.
{
  const shoes = await ask("shoes"), top = shoes.items[0].p;
  for (const q of ["are these are too expensive", "these are too expensive", "too expensive", "too dear", "thats a bit pricey", "that is a bit much", "i cant afford that", "out of my budget", "that costs too much"]) {
    const r = await ask(q, { voice: true, ctx: shoes.ctx });
    ok(r.viaAi && /^cheaper than /.test(r.order || ""), `${q}: should ask for cheaper: ${r.route} ${r.order}`);
    ok((r.pool || []).length && r.pool.every(p => +p.price < +top.price), `${q}: everything listed should be under ${top.price}: ${(r.pool || []).map(p => p.price)}`);
  }
  // Following up with no product named stays on the same product, however it starts.
  const footwear = /shoe|boot|sock|slide|thong|sandal|footwear|crocs|gumboot/i;
  for (const q of ["yeah the cheapest", "yeah just what's the cheapest ones", "which ones are cheapest", "which is the cheapest", "the cheapest ones"]) {
    const r = await ask(q, { voice: true, ctx: shoes.ctx });
    ok(r.order === "cheapest first", `${q}: should be in price order: ${r.route} ${r.order}`);
    ok((r.pool || []).length && r.pool.slice(0, 4).every(p => footwear.test(`${p.name} ${p.cat}`)), `${q}: should stay on shoes: ${(r.pool || []).slice(0, 4).map(p => p.name)}`);
  }
  for (const q of ["most expensive tent", "expensive tent"]) {
    const r = await ask(q);
    ok(r.order === "dearest first", `${q}: should still mean the dearest: ${r.order}`);
  }
}

// Typing makes typos, not mishearings: only what's spoken gets sound-alike guesses.
for (const [q, typed, spoken] of [
  ["hiking sues", "hiking sues", "hiking {sues:shoes}"], ["reign jacket", "reign jacket", "{reign:rain} jacket"], ["fishing lion", "fishing lion", "fishing {lion:line}"],
  ["attempt", "attempt", "{attempt:tent}"], ["tnet", "{tnet:tent}", null], ["kyak", "{kyak:kayak}", null], ["fishign rod", "{fishign:fishing} rod", null], ["camping chiar", "camping {chiar:chair}", null],
]) {
  const t = await ask(q);
  ok((t.sentAs || t.q) === typed, `${q} (typed): should reach the AI as ${typed}: ${t.route} ${t.sentAs || t.q}`);
  if (spoken) {
    const s = await ask(q, { voice: true });
    ok((s.sentAs || s.q) === spoken, `${q} (spoken): should reach the AI as ${spoken}: ${s.route} ${s.sentAs || s.q}`);
  }
}

// Everyday words the catalogue doesn't use, where the word itself would find something unrelated: "jumper" is a brand
// of lure and "swimmers" a Daiwa reel. Then the real names those rules must leave alone.
for (const [q, re] of [
  ["jumper", /pullover|fleece|hoodie|sweater/i], ["i want a jumper", /pullover|fleece|hoodie|sweater/i], ["mens jumper", /pullover|fleece|hoodie|sweater/i],
  ["swimmers", /swim|surf/i], ["togs", /swim|surf/i], ["bathers", /swim|surf/i], ["boardies", /board short/i],
  ["mozzie spray", /repell/i], ["bug spray", /repell/i], ["pegs", /\bpegs?\b/i], ["i need some pegs", /\bpegs?\b/i],
  ["jumper leads", /jumper leads/i], ["stump jumper", /stumpjumper/i], ["free swimmer", /free swimmer/i], ["sand pegs", /sand peg/i], ["swim goggles", /goggle/i],
]) {
  for (const voice of [false, true]) {
    const r = await ask(q, { voice });
    const tops = (r.items || []).slice(0, 3).map(i => i.p);
    ok(tops.length && tops.every(p => re.test(`${p.name} ${p.cat}`)), `${q}${voice ? " (voice)" : ""}: ${tops.map(p => p.name)}`);
  }
}

const sorted = [...stamps].sort((a, b) => a - b);
const pct = p => sorted[Math.floor(sorted.length * p)].toFixed(0);
console.log(`\n${DB.length} products | ${calls} requests to the live server | median ${pct(0.5)}ms, 95th ${pct(0.95)}ms, slowest ${slowest.toFixed(0)}ms from this PC`);
console.log(`${pass} passed, ${fail} failed`);
for (const f of fails) console.log("  FAIL", f);
process.exit(fail ? 1 : 0);
