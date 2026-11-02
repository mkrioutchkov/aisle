// Loads the catalogue into the database: products with their search tokens and sizes, stock per store, and every
// word with how it sounds. The real pilot replaces the stock and shelf columns with Anaconda's feeds.
//   node scripts/seed.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { toks, norm, stem, sound, soundClass, headsOf, ATTR, STOP, KIDS_IN_NAME, bayes } from "../supabase/functions/api/text.mjs";
import { sql, insert } from "./sb.mjs";

const read = f => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const DB = read("brendale.json"), IMG = read("brendale-img.json"), TAX = read("taxonomy.json");
const BASE = "https://www.anacondastores.com", STORES = [["brendale", "Brendale", "QLD"], ["chermside", "Chermside", "QLD"], ["tingalpa", "Tingalpa", "QLD"]];

// A shopper's word that fits many categories doesn't help find any of them.
const akaUse = new Map();
for (const terms of Object.values(DB.aka || {})) for (const t of new Set(terms.flatMap(toks))) akaUse.set(t, (akaUse.get(t) || 0) + 1);
const akaTokens = c => [...new Set((DB.aka[c] || []).flatMap(toks).filter(t => !STOP.has(t) && akaUse.get(t) <= 4))];
const accessories = new Set(DB.accessories || []);
const cats = [...new Set(DB.products.map(p => p.cat))];

const memo = new Map();
const tokList = s => { let t = memo.get(s); if (!t) { t = [...new Set(toks(s))]; memo.set(s, t); } return t; };
const uniq = a => [...new Set(a)];

const products = DB.products.map(p => {
  const nameList = toks(p.name), cat = tokList(p.cat), brand = tokList(p.brand || ""), dept = tokList(p.dept || ""), aka = akaTokens(p.cat), b = bayes(p);
  return {
    id: p.id, name: p.name, brand: p.brand, cat: p.cat, dept: p.dept, price: p.price, rating: p.rating, reviews: p.reviews,
    url: `${BASE}/en-au/p/${p.url}`, img: IMG[p.id] ? `${BASE}/medias/${IMG[p.id]}` : null,
    name_tokens: uniq(nameList), cat_tokens: cat, brand_tokens: brand, dept_tokens: dept, aka_tokens: aka,
    all_tokens: uniq([...nameList, ...cat, ...brand, ...dept, ...aka]), heads: headsOf(p.cat),
    name_str: ` ${nameList.join(" ")} `, cat_str: cat.filter(t => !STOP.has(t)).join(" "),
    kids: KIDS_IN_NAME.test(`${p.name} ${p.cat}`), acc: accessories.has(p.cat),
    persons: ATTR.persons(p.name), litres: ATTR.litres(p.name), cans: ATTR.cans(p.name), lumens: ATTR.lumens(p.name), degrees: ATTR.degrees(p.name), feet: ATTR.feet(p.name),
    bayes: +b.toFixed(4), value: +(b * b / Math.log10(p.price + 10)).toFixed(4),
  };
});

// Words: how often each appears, how it sounds, and whether it names a kind of product.
const df = new Map(), catWords = new Set(["esky"]), headWords = new Set(["cooler"]), lastInName = new Map();
for (const p of products) {
  for (const t of p.all_tokens) df.set(t, (df.get(t) || 0) + 1);
  const alpha = p.name_tokens.length ? toks(p.name).filter(w => /^[a-z]+$/.test(w)) : [];
  const end = alpha[alpha.length - 1];
  if (end) lastInName.set(end, (lastInName.get(end) || 0) + 1);
}
for (const c of cats) {
  for (const t of tokList(c)) catWords.add(t);
  for (const h of headsOf(c)) headWords.add(h);
  for (const t of akaTokens(c)) catWords.add(t);
  // The last word of each shopper term is the noun: "tent pegs" is about pegs.
  for (const term of DB.aka[c] || []) {
    const parts = toks(term).filter(t => !STOP.has(t) && akaUse.get(t) <= 4);
    if (parts.length) headWords.add(parts[parts.length - 1]);
  }
}
for (const [w, n] of lastInName) if (n >= 5) headWords.add(w);
const words = [...new Set([...df.keys(), "esky"])].map(w => ({
  word: w, df: df.get(w) || 0, sound: sound(w), class: soundClass(sound(w)), cat_word: catWords.has(w), head: headWords.has(w),
}));

// Stock and shelf per store. Brendale's come straight from the catalogue file; other stores vary by a hash of the id.
const h = s => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16);
const placements = [];
for (const [slug] of STORES) {
  for (const p of DB.products) {
    const v = h(`${slug}:${p.id}`);
    placements.push(slug === "brendale"
      ? { store: slug, product_id: p.id, aisle: p.aisle, bay: p.bay, stock: p.stock }
      : { store: slug, product_id: p.id, aisle: p.aisle, bay: 1 + (p.bay + v % 3 - 1) % 12, stock: v % 11 === 0 ? 0 : 1 + v % 24 });
  }
}

console.log("clearing");
await sql("truncate placements, products, categories, aisles, stores, words, facilities restart identity cascade");
console.log("stores, aisles, categories");
await insert("stores", STORES.map(([slug, name, state]) => ({ slug, name, state })));
await insert("aisles", DB.aisles.map(a => ({ n: a.n, dept: a.dept, label: a.label })));
await insert("categories", cats.map(c => ({ name: c, aisle: TAX[c].aisle, accessory: !!TAX[c].accessory, aka: TAX[c].aka || [] })));
await insert("facilities", DB.facilities.map(f => ({ keys: f.keys, answer: f.answer, zone: null })));
console.log("products", products.length);
await insert("products", products, 1500);
console.log("words", words.length);
await insert("words", words, 3000);
console.log("placements", placements.length);
await insert("placements", placements, 4000);
await sql("analyze products; analyze placements; analyze words;");
console.log(await sql("select (select count(*) from products) products, (select count(*) from placements) placements, (select count(*) from words) words, (select count(*) from words where head) heads, pg_size_pretty(pg_database_size(current_database())) size"));
