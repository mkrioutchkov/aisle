// How words are read: shared by the server function and the script that loads the catalogue, so a question
// and a product name are always broken into the same tokens. No database here, so it's easy to test.

// Multi-word names collapse to one token on BOTH the question and the catalogue side.
const PHRASES = [
  [/\bhead ?(torch|lamp|light)(es|s)?\b/g, "headlamp"],
  [/\bair ?(bed|mattress)(es|s)?\b/g, "airbed"],
  [/\b(chilly ?bins?|eskys|eskies|esky|ice ?box(es)?)\b/g, "cooler"],
  [/\bflip ?flops?\b/g, "thongs"],
  [/\blife ?(vest|jacket)s?\b/g, "pfd"],
  [/\b(stand ?up )?paddle ?boards?\b|\bsups?\b/g, "paddleboard"],
  [/\bsleeping ?mats?\b/g, "mattress"],
  [/\brain ?coats?\b/g, "rain jacket"],
  [/\bblow ?up\b/g, "inflatable"],
  [/\b(people|persons)\b/g, "person"],
  [/\bback ?packs?\b/g, "backpack"],
  [/\bsun ?glasses\b/g, "sunglasses"],
  [/\bwet ?suits?\b/g, "wetsuit"],
  // What shoppers call things the catalogue names differently, where the word itself would find something unrelated:
  // "jumper" is a brand of lure and "swimmers" a Daiwa reel. Those real names stay as they are.
  [/(?<!stump )\bjumpers?\b(?! leads?| cables?)/g, "pullover"],
  [/\bboardies\b/g, "board shorts"],
  [/(?<!free )\bswimmers\b|\b(togs|bathers|cossies?|cozzies?|swimming costumes?|bathing suits?)\b/g, "swimwear"],
  [/\b(mozzie|mosquito|insect|bug|fly) sprays?\b/g, "insect repellent"],
];
// Most product names contain none of these, so they skip the phrase rules entirely.
const PHRASE_HINT = /head|air|chilly|esk|ice|flip|life|paddle|sup|sleeping|rain|blow|people|person|back|sun|wet|jumper|boardies|swim|togs|bathers|coss|cozz|bathing|spray/;
const KEEP = new Set(["gas", "plus", "lens", "canvas", "series", "thermos", "bass", "cross", "glass"]);

export const stem = w => {
  if (w.length <= 3 || KEEP.has(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ch|sh|x|ss|zz)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
};

export const norm = s => {
  let t = String(s).toLowerCase();
  if (/[^\x00-\x7f]/.test(t)) t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/['’`]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9\s]/g, " ");
  if (PHRASE_HINT.test(t)) for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t.replace(/\s+/g, " ").trim();
};
export const toks = s => norm(s).split(" ").filter(Boolean).map(stem);

export const STOP = new Set(("a an the is are was were where wheres whats what which who how do does did you your yours have has had got get " +
  "any anything i im ive id me my we our us need needs want wanna gonna looking look find finding show tell please can could would will " +
  "like in on of at to for from with and or about some there here store shop aisle bay sell selling buy buying kind sort type " +
  "one thing stuff hey hi hello mate um uh ok okay just also this that these those it its be keep kept located location guys yous " +
  "much many cost price stock stocked available left go going trip weekend holiday new good best cheap cheapest budget " +
  "recommend suggest something item should bring take start starting use using try trying think know see put make " +
  "gday ill give gimme after chasing actually alright already again always anyway around across ahead help reckon maybe hope hoping chance fetch point").split(/\s+/));

// A word that means something narrower when it's all that was asked. Real pegs are tent accessories, so "pegs" alone
// would find a peg hammer first.
export const ALONE = { peg: "tent pegs" };
export const SYN = {
  torch: "torch|flashlight", flashlight: "torch", peg: "peg|stake", stake: "peg",
  mattress: "mattress|airbed|mat", mat: "mat|mattress", airbed: "airbed|mattress",
  thong: "thong|slide", slide: "slide|thong", jandal: "thong",
  gas: "gas|butane|propane", butane: "butane|gas", canister: "canister|cartridge|cylinder|bottle", cartridge: "cartridge|canister", cylinder: "cylinder|bottle|canister",
  bbq: "bbq|barbecue|grill", barbie: "bbq", barbecue: "bbq|barbecue",
  kid: "kid|junior|youth|child|children", child: "kid|junior|youth", children: "kid|junior|youth", junior: "junior|kid|youth",
  pfd: "pfd|buoyancy", bicycle: "bike", paddleboard: "paddleboard|sup",
  coat: "coat|jacket", boot: "boot|shoe", shoe: "shoe|boot", sneaker: "shoe", runner: "shoe",
  rucksack: "pack|backpack", backpack: "backpack|pack", lamp: "lamp|lantern|light", light: "light|lantern|lamp",
  stove: "stove|cooker|burner", cooker: "stove|cooker", pot: "pot|saucepan|billy", pan: "pan|frypan|skillet",
  line: "line|braid|mono", hat: "hat|cap|beanie", lure: "lure|plastic|vibe", sinker: "sinker|terminal",
  fridge: "fridge|freezer", freezer: "freezer|fridge", bottle: "bottle|flask", chair: "chair|stool", seat: "seat|chair",
  tarp: "tarp|tarpaulin", cooler: "cooler|icebox",
};

export const words = q => norm(q).split(" ").filter(w => w && !STOP.has(w)).map(stem).filter(w => !STOP.has(w));
export const money = v => v == null ? "" : "$" + (Number.isInteger(+v) ? +v : (+v).toFixed(2));
export const where = p => `Aisle ${p.aisle}, Bay ${p.bay}`;
export const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// How a word sounds. Speech recognition swaps vowels and similar consonants far more than anything else
// ("tint" for tent, "road" for rod, "share" for chair), so words are compared by their consonant skeleton.
export function sound(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "")
    .replace(/^(kn|gn|pn)/, "n").replace(/^wr/, "r").replace(/^wh/, "w").replace(/^x/, "s")
    .replace(/ph/g, "f").replace(/gh/g, "").replace(/ck/g, "k").replace(/q/g, "k").replace(/sch/g, "sk")
    .replace(/tch/g, "X").replace(/(sh|ch)/g, "X").replace(/th/g, "t").replace(/dge/g, "j").replace(/ge$/, "j")
    .replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/x/g, "ks").replace(/z/g, "s").replace(/ing$/, "n").replace(/mb$/, "m");
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i], next = w[i + 1] || "", isV = /[aeiou]/.test(next);
    let keep = c;
    if (/[aeiou]/.test(c)) keep = i === 0 ? "A" : "";
    else if (c === "y" || c === "w" || c === "h") keep = isV ? c : (i === 0 && c === "y" ? "A" : "");
    if (keep && out[out.length - 1] !== keep) out += keep;
  }
  return out;
}
const CLASS = { b: "p", d: "t", g: "k", v: "f", j: "X", m: "n" };
export const soundClass = s => s.replace(/[bdgvjm]/g, c => CLASS[c]);
// It also swaps s and sh ("facing" for fishing), but that's too loose for the class stored with each word.
export const unhushed = c => c.replace(/X/g, "s");

// Things people say that aren't product words, so they never get "corrected" into one.
export const SMALLTALK = new Set("thanks thank cheers yes yeah yep no nope sorry bye goodbye lol wow great nice cool awesome why when who joke funny love hate weather today tomorrow".split(" "));

// ---------- reading a question: price limits, group size, and what to rank by ----------
export const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export const NUM = `(\\d+|${Object.keys(NUMW).join("|")})`;
const AMT = "\\$?\\s*(\\d+(?:\\.\\d+)?)(k)?";
const BUCKS = "(?:\\s*(?:bucks?|dollars?))?";
const NOT_UNIT = "(?!\\s*(?:kg|g|l|lt|litres?|liters?|ft|feet|foot|m|cm|mm|in|inch|inches|person|people|kids?|years?|yrs?|degrees?|c|lumens?|cans?|pack|km|hp|watts?|w|v|wd)\\b)";
const amt = (n, k) => parseFloat(n) * (k ? 1000 : 1);
const RELATIVE = [
  [/\b(cheaper|less expensive|lower price|lower priced|more affordable|less money|save (?:some )?money)\b/, "cheaper"],
  [/\b(more expensive|dearer|pricier|higher end|step up|fancier|nicer)\b/, "dearer"],
  [/\b(better quality|higher quality|better rated|higher rated|better)\b/, "better"],
  [/\b(bigger|larger)\b/, "bigger"],
  [/\b(smaller|more compact)\b/, "smaller"],
  [/\b(another|something else|anything else|other options?|other ones?|what else|next one|different one|others?)\b/, "next"],
];
export const REL_SORT = { cheaper: "price-asc", dearer: "price-desc", better: "rating", bigger: "size-desc", smaller: "size-asc" };
const CUES = [
  [/\b(dont|do not|wouldnt|not after|nothing)\b.{0,24}\b(expensive|dear|pricey|costly)\b|\bnot (?:too |so |very |that |super |overly )?(?:expensive|dear|pricey|costly)\b|\binexpensive\b/, "price-asc"],
  [/\b(best value|good value|great value|value for money|bang for (?:your |my |the )?buck|best deal|cheap (?:but|and|yet) (?:good|decent)|(?:good|decent) (?:but|and|yet) cheap|best cheap|good cheap|decent cheap|cheapest (?:good|decent))\b/, "value"],
  [/\b(most popular|best sell(?:er|ing)s?|bestsellers?|most reviewed|popular)\b/, "popular"],
  [/\b(cheapest|lowest (?:price|priced|cost)|least expensive|most affordable|affordable|on a budget|budget|bargain|entry level|low cost|cheap as chips|costs? the least|least money|cheap)\b/, "price-asc"],
  [/\b(most expensive|priciest|dearest|most costly|highest (?:price|priced)|top of the range|top of range|top end|high end|premium|luxury|fanciest|flashest|money no object|no expense spared|costs? the most|most money|expensive|pricey)\b/, "price-desc"],
  [/\b(brightest|most powerful|strongest beam)\b/, "bright"],
  [/\bwarmest\b/, "warm"],
  [/\blongest\b/, "long"],
  [/\bshortest\b/, "short"],
  [/\b(biggest|largest|huge)\b/, "size-desc"],
  [/\b(smallest|tiniest|most compact)\b/, "size-asc"],
  [/\b(best quality|highest quality|top quality|good quality|great quality|best rated|highest rated|top rated|best reviewed|best reviews|quality|best|greatest|nicest|finest|recommended|top pick|good)\b/, "rating"],
];
export const HEAD = {
  "price-asc": "cheapest", "price-desc": "most expensive", rating: "top rated", popular: "most popular", value: "best value",
  "size-desc": "biggest", "size-asc": "smallest", bright: "brightest", warm: "warmest", long: "longest", short: "shortest",
};

export function parseAsk(q) {
  let t = ` ${String(q).toLowerCase().replace(/['’`]/g, "").replace(/(\d),(?=\d{3})/g, "$1").replace(/[?!.]+(\s|$)/g, " ")} `;
  t = t.replace(/\b(?:a|one) hundred\b/g, "100").replace(/\btwo hundred\b/g, "200").replace(/\bthree hundred\b/g, "300").replace(/\bfive hundred\b/g, "500")
    .replace(/\bfifty\b/g, "50").replace(/\btwenty\b/g, "20").replace(/\bthirty\b/g, "30").replace(/\bforty\b/g, "40");
  // Numbers get heard as their sound-alikes: "four person tent" arrives as "for person tent".
  t = t.replace(/\b(?:for|fore)\s+(?:person|people|man)\b/g, "4 person").replace(/\b(?:to|too)\s+(?:person|people|man)\b/g, "2 person").replace(/\bate\s+(?:person|people|man)\b/g, "8 person");
  const a = { sort: null, rel: null, min: null, max: null, persons: 0, limit: "", ai: false, rest: "" };
  const cut = (re, fn) => {
    const m = t.match(re);
    if (!m) return false;
    fn(m);
    t = t.replace(re, " ");
    return true;
  };
  if (/\bnot (?:the )?(?:cheapest|most expensive)\b/.test(t)) a.ai = true;
  cut(new RegExp(`\\b(?:between|from)\\s*${AMT}${BUCKS}\\s*(?:and|to|-)\\s*${AMT}${BUCKS}`), m => {
    a.min = amt(m[1], m[2]); a.max = amt(m[3], m[4]); a.limit = ` between ${money(a.min)} and ${money(a.max)}`;
  }) || cut(new RegExp(`\\b(?:under|below|less than|cheaper than|no more than|not more than|up to|at most|max(?:imum)?(?: of)?)\\s*${AMT}${NOT_UNIT}${BUCKS}`), m => {
    a.max = amt(m[1], m[2]); a.limit = ` under ${money(a.max)}`;
  }) || cut(new RegExp(`\\b(?:over|above|more than|at least|min(?:imum)?(?: of)?)\\s*${AMT}${NOT_UNIT}${BUCKS}`), m => {
    a.min = amt(m[1], m[2]); a.limit = ` over ${money(a.min)}`;
  }) || cut(new RegExp(`\\b(?:around|about|roughly|approx(?:imately)?)\\s*${AMT}${NOT_UNIT}${BUCKS}`), m => {
    const v = amt(m[1], m[2]); a.min = v * 0.8; a.max = v * 1.2; a.limit = ` around ${money(v)}`;
  }) || cut(/\$\s*(\d+(?:\.\d+)?)(k)?|\b(\d+)(k)?\s*(?:bucks?|dollars?)\b/, m => {
    const v = m[1] ? amt(m[1], m[2]) : amt(m[3], m[4]); a.min = v * 0.8; a.max = v * 1.2; a.limit = ` around ${money(v)}`;
  });
  const count = s => NUMW[s] || parseInt(s, 10);
  cut(new RegExp(`\\b(?:family of|group of|sleeps|for)\\s+${NUM}(?:\\s*(?:person|people|of us|adults?))?\\b(?!\\s*(?:kids?|children))`), m => { a.persons = count(m[1]); })
    || cut(new RegExp(`\\b${NUM}\\s*-?\\s*(?:person|people|man)\\b`), m => { a.persons = count(m[1]); });
  // A choice between things needs advice, not a ranking. Price ranges are already cut out by here.
  if (/\b(or|vs|versus|compare|difference|between)\b/.test(t)) a.ai = true;
  for (const [re, rel] of RELATIVE) if (cut(re, () => { a.rel = rel; })) break;
  for (const [re, sort] of CUES) if (cut(re, () => { a.sort = sort; })) break;
  a.rest = t.replace(/\s+/g, " ").trim();
  return a;
}

const num = (re, s) => { const m = s.match(re); return m ? parseFloat(m[1]) : null; };
export const ATTR = {
  persons: n => num(/(\d+)\s*-?\s*v?\s*person/i, n),
  litres: n => num(/(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)\b/i, n),
  cans: n => num(/(\d+)\s*(?:\+\s*\d+\s*)?can\b/i, n),
  lumens: n => num(/(\d+)\s*lumens?/i, n.replace(/,/g, "")),
  degrees: n => num(/(-?\d+)\s*°/, n),
  feet: n => { const m = n.match(/(\d+)\s*(?:'|ft\b|foot\b|feet\b)\s*(\d+)?/i); return m ? +m[1] + (+m[2] || 0) / 12 : null; },
};
export const bayes = p => ((p.rating || 4.2) * p.reviews + 4.2 * 20) / (p.reviews + 20);
export const KIDS_IN_NAME = /\b(kids?|junior|youth|toddler|child|children)\b/i;
export const KIDS_RE = /\b(kids?|child|children|junior|youth|son|daughter|toddler|boy|girl|year old|yo)\b/;
// A "swag bag" or "rod holder" goes with the thing rather than being it.
export const ADD_ONS = "bag|cover|peg|pole|mat|repair|kit|holder|rack|liner|strap|seat|case|sock|tube|light|part|carrier|stand|tie|cord|rope|footprint|topper|mattress|paddle|tip|butt|handle|oil|grease|cleaner|spray";

// What a category is made of: "Camping Stoves & BBQs" is stoves and BBQs. "Rod & Reel Combos" is
// combos, because a lone word before the "&" just shares the noun after it.
export function headsOf(cat) {
  const parts = cat.split(/\s*(?:&|,|\band\b)\s*/).map(toks).filter(t => t.length);
  return [...new Set(parts.filter((t, i) => !(t.length === 1 && parts[i + 1] && parts[i + 1].length >= 2)).map(t => t[t.length - 1]))];
}

// ---------- shopping-list kits: [label, search query, quantity per person (0 = one for the group)] ----------
export const KITS = {
  camping: { title: "camping", items: [["Tent", "camping tent"], ["Sleeping bag", "sleeping bag", 1], ["Airbed", "airbed", 0.5], ["Camp chair", "camping chair", 1], ["Lantern", "lantern"], ["Head torch", "headlamp", 1], ["Cooler", "hard cooler"], ["Stove", "camping stove"], ["Gas", "butane canister"]] },
  fishing: { title: "fishing", items: [["Rod and reel combo", "spinning combo", 1], ["Braid line", "braid line"], ["Soft plastics", "soft plastic"], ["Hard body lure", "hard body lure"], ["Tackle box", "tackle box"], ["Bait", "bait"]] },
  hiking: { title: "hiking", items: [["Hiking pack", "hiking pack", 1], ["Hydration", "hydration", 1], ["Hiking boots", "hiking boot", 1], ["Rain jacket", "rain jacket", 1], ["Head torch", "headlamp", 1], ["First aid kit", "first aid kit"]] },
  beach: { title: "beach", items: [["Beach shelter", "beach tent"], ["Umbrella", "beach umbrella"], ["Beach chair", "beach chair", 1], ["Beach trolley", "beach trolley"], ["Cooler bag", "cooler bag"]] },
  kayaking: { title: "kayaking", items: [["Kayak", "kayak"], ["Life jacket", "pfd", 1], ["Dry storage", "dry bag"]] },
  "4wd": { title: "4WD", items: [["Air compressor", "air compressor"], ["Recovery gear", "recovery"], ["Driving lights", "light bar"], ["Fridge", "fridge freezer"]] },
};
export const KIT_RE = /\b(trip|weekend|holiday|getaway|beginners?|starter|first time|what (do|should) (i|we) (need|get|bring|buy|take)|checklist|kit|set ?up|going)\b/;
export const KIT_TOPIC = [["camping", /\bcamp(ing)?\b/], ["fishing", /\bfish(ing)?\b/], ["hiking", /\b(hik(e|ing)|bushwalk(ing)?|trek(king)?)\b/],
  ["beach", /\bbeach\b/], ["kayaking", /\bkayak(ing)?\b/], ["4wd", /\b(4wd|4x4|off ?road(ing)?)\b/]];
export const KIT_NOISE = /\b(kids?|children|family|wife|husband|partner|mates?|friends?|dad|mum|mom|son|daughter|boys?|girls?|person|beginners?|starter|first|time|setup|set up|checklist|kit|bring|take|\d+|one|two|three|four|five|six)\b/g;
export const ZONE_OF = { toilet: "toilets", "service desk": "service", "click and collect": "service", "fitting room": "fitting", checkout: "checkouts", trolley: "entrance" };
// Questions about the store rather than its products: the AI can answer or send them to the desk.
export const STORE_RE = /\b(price match(ing)?|match(es)? (a |the )?price|are you open|open (on|till|until|today|tomorrow|late)|opening hours|what time|closing time|trading hours|warranty|policy|policies|afterpay|zip pay|lay ?by|gift cards?|vouchers?|member(ship)?s?|loyalty|discount|on sale|specials|delivery|deliver|parking|manager|jobs?|staff|(speak|talk) to|someone|somebody|a person)\b/;
export const REAL_RE = /\b(is (this|that|it|the stock) real|(is|are) (the |these |those )?(stock|prices?|products?|locations?|aisles?|bays?)( numbers?)? real|real (stock|data|prices?)|sample data|fake|demo)\b/;
// Questions asking for judgement rather than a thing: these go to the AI even when every word is a product word.
export const ADVICE_RE = /\b(which|should|would|why|how (do|can|to|should|does)|what (do|should|can|would|is|are|goes|fits)|whats|good for|suits?|suitable|recommend|suggest|help|want to|need to|going to|trying to|for my|to keep|to stop|that one|this one|those|them|difference|compare|versus|vs|or)\b/;
// Same, for a ranking: "what's the cheapest rod" is still a ranking, "cheapest rod for my bad back" isn't.
export const RANK_ADVICE_RE = /\b(which|should|would|why|how (do|can|to|should|does)|good for|suits?|suitable|recommend|suggest|help|want to|need to|going to|trying to|for my|to keep|to stop|difference|compare|versus|vs|or)\b/;
// Everyday words that point at a shelf, so the AI gets the right products to choose from.
export const CONCEPTS = [
  [/\b(beers?|drinks?|cold|ice|chill\w*)\b/, ["cooler"]],
  [/\b(rain\w*|wet|storm\w*|waterproof)\b/, ["rain jacket"]],
  [/\b(feet|foot|toes?|blisters?)\b/, ["hiking boots", "hiking socks"]],
  [/\b(night|dark)\b/, ["headlamp", "lantern"]],
  [/\b(freez\w*|winter|snow|warm\w*|down|synthetic|insulat\w*)\b/, ["sleeping bag", "thermal", "down jacket"]],
  [/\b(sleep\w*|bed)\b/, ["sleeping bag", "airbed"]],
  [/\b(cook\w*|dinner|breakfast|food|meals?)\b/, ["camping stove", "cookware"]],
  [/\b(thirst\w*|water|hydrat\w*)\b/, ["hydration", "water"]],
  [/\b(fish\w*|angl\w*|catch\w*)\b/, ["combo", "tackle box", "soft plastic"]],
  [/\b(sit|seats?|relax\w*)\b/, ["camping chair"]],
  [/\b(bogged|stuck|flat)\b/, ["recovery", "air compressor"]],
  [/\bcrab\w*\b/, ["crab pot", "bait"]],
  [/\b(sun\w*|shade|uv)\b/, ["sunscreen", "rash vest", "sun hat", "beach umbrella", "beach tent"]],
  [/\b(mozzies?|mosquito\w*|bugs?|insects?|flies|midges?)\b/, ["insect repellent", "mosquito", "mozzie"]],
];
