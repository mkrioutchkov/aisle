"use strict";
// In-store product finder. Everything runs in the browser against data/<store>.json:
// instant local search (synonyms, fuzzy match), shopping-list "kits", store facilities,
// voice in (Web Speech API) and voice out. An optional AI endpoint (config.js) answers
// open questions the local search can't.
(() => {
  const params = new URLSearchParams(location.search);
  const slug = (params.get("store") || "brendale").toLowerCase().replace(/[^a-z0-9-]/g, "") || "brendale";
  const AI = String(window.AISLE_AI || "").trim();
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const titleCase = s => s.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const saved = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---------- text ----------
  // Multi-word names collapse to one token on BOTH the query and the catalogue side.
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
  ];
  const KEEP = new Set(["gas", "plus", "lens", "canvas", "series", "thermos", "bass", "cross", "glass"]);
  const stem = w => {
    if (w.length <= 3 || KEEP.has(w)) return w;
    if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
    if (/(ch|sh|x|ss|zz)es$/.test(w)) return w.slice(0, -2);
    if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
    return w;
  };
  const norm = s => {
    let t = String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/['’`]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9\s]/g, " ");
    for (const [re, to] of PHRASES) t = t.replace(re, to);
    return t.replace(/\s+/g, " ").trim();
  };
  const toks = s => norm(s).split(" ").filter(Boolean).map(stem);

  const STOP = new Set(("a an the is are was were where wheres whats what which who how do does did you your have has had got get " +
    "any anything i im ive me my we our us need needs want wanna looking look find finding show tell please can could would will " +
    "like in on of at to for from with and or about some there here store shop aisle bay sell selling buy buying kind sort type " +
    "one thing stuff hey hi hello mate um uh ok okay just also this that these those it its be keep kept located location " +
    "much many cost price stock stocked available left go going trip weekend holiday new good best cheap cheapest budget " +
    "recommend suggest something").split(/\s+/));
  const SYN = {
    torch: "torch|flashlight", flashlight: "torch", peg: "peg|stake", stake: "peg",
    mattress: "mattress|airbed|mat", mat: "mat|mattress", airbed: "airbed|mattress",
    thong: "thong|slide", slide: "slide|thong", jandal: "thong",
    gas: "gas|butane|canister|cartridge", butane: "butane|gas", canister: "canister|cartridge|butane", cartridge: "cartridge|canister",
    bbq: "bbq|barbecue|grill", barbie: "bbq", barbecue: "bbq|barbecue",
    kid: "kid|junior|youth|child|children", child: "kid|junior|youth", children: "kid|junior|youth", junior: "junior|kid|youth",
    pfd: "pfd|buoyancy", bicycle: "bike", paddleboard: "paddleboard|sup",
    coat: "coat|jacket", boot: "boot|shoe", shoe: "shoe|boot", sneaker: "shoe", runner: "shoe",
    rucksack: "pack|backpack", backpack: "backpack|pack", lamp: "lamp|lantern|light", light: "light|lantern|lamp",
    stove: "stove|cooker|burner", cooker: "stove|cooker", pot: "pot|saucepan|billy", pan: "pan|frypan|skillet",
    line: "line|braid|mono", hat: "hat|cap|beanie", lure: "lure|plastic|vibe", sinker: "sinker|terminal",
    fridge: "fridge|freezer", freezer: "freezer|fridge", bottle: "bottle|flask", chair: "chair|seat|stool", seat: "seat|chair",
    tarp: "tarp|tarpaulin", cooler: "cooler|icebox",
  };

  // ---------- index + search ----------
  let DB = null, IDX = null;
  function buildIndex(products, aisles) {
    const label = new Map(aisles.map(a => [a.n, a.label]));
    const df = new Map();
    const docs = products.map(p => {
      const name = new Set(toks(p.name)), cat = new Set(toks(`${p.cat} ${label.get(p.aisle) || ""}`));
      const brand = new Set(toks(p.brand)), dept = new Set(toks(p.dept));
      for (const t of new Set([...name, ...cat, ...brand, ...dept])) df.set(t, (df.get(t) || 0) + 1);
      return { p, name, cat, brand, dept, nameStr: ` ${toks(p.name).join(" ")} ` };
    });
    const N = docs.length;
    return { docs, df, vocab: [...df.keys()], idf: t => Math.log(1 + N / (df.get(t) || 1)) };
  }
  const fieldW = (d, t) => d.name.has(t) ? 3 : d.cat.has(t) ? 2.2 : d.brand.has(t) ? 1.8 : d.dept.has(t) ? 1 : 0;

  function lev(a, b, max) {
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

  const words = q => norm(q).split(" ").filter(w => w && !STOP.has(w)).map(stem).filter(w => !STOP.has(w));

  function terms(q) {
    return words(q).map(w => {
      const alts = [{ toks: [w], w: 1 }];
      for (const s of (SYN[w] || "").split("|")) if (s && s !== w) alts.push({ toks: toks(s), w: 0.9 });
      if (!IDX.df.has(w) && !/^\d+$/.test(w)) {
        const max = w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;
        let extra = 0;
        for (const v of IDX.vocab) {
          if (extra >= 8) break;
          if (w.length >= 3 && v.startsWith(w)) { alts.push({ toks: [v], w: 0.75 }); extra++; }
          else if (max && lev(w, v, max) <= max) { alts.push({ toks: [v], w: 0.6 }); extra++; }
        }
      }
      return { w, alts };
    });
  }

  function search(q, limit = 12) {
    const T = terms(q);
    if (!T.length) return [];
    const phrase = ` ${T.map(t => t.w).join(" ")} `;
    const out = [];
    for (const d of IDX.docs) {
      let s = 0, hit = 0;
      for (const t of T) {
        let best = 0;
        for (const a of t.alts) {
          let fw = 9, idf = 0, ok = true;
          for (const k of a.toks) {
            const f = fieldW(d, k);
            if (!f) { ok = false; break; }
            fw = Math.min(fw, f);
            idf += IDX.idf(k);
          }
          if (ok) best = Math.max(best, a.w * fw * idf / a.toks.length);
        }
        if (best) { s += best; hit++; }
      }
      if (!hit) continue;
      const cov = hit / T.length;
      s *= 0.3 + 0.7 * cov * cov;
      if (T.length > 1 && d.nameStr.includes(phrase)) s *= 1.25;
      s += Math.log10(1 + d.p.reviews) * 0.15;
      out.push({ p: d.p, s, cov });
    }
    out.sort((a, b) => b.s - a.s);
    const top = out.length ? out[0].s : 0;
    return out.filter(x => x.s >= top * 0.5).slice(0, limit);
  }

  // ---------- intents ----------
  const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  const W = "(\\d+|one|two|three|four|five|six|seven|eight)";
  function people(qn) {
    const num = s => NUM[s] || +s;
    const m = qn.match(new RegExp(`\\b(?:family|group|party) of ${W}\\b`)) || qn.match(new RegExp(`\\bfor ${W}\\b`));
    if (m) return Math.min(num(m[1]), 12);
    let n = 0;
    for (const k of qn.matchAll(new RegExp(`\\b${W} (kids?|children|adults?|people|mates|friends)\\b`, "g"))) n += num(k[1]);
    if (n && /\b(kids?|children)\b/.test(qn) && !/\badults?\b/.test(qn)) n += 2;
    return Math.min(n, 12);
  }

  // [label, search query, quantity per person (0 = one for the group)]
  const KITS = {
    camping: { title: "camping", items: [["Tent", "camping tent"], ["Sleeping bag", "sleeping bag", 1], ["Airbed", "airbed", 0.5], ["Camp chair", "camping chair", 1], ["Lantern", "lantern"], ["Head torch", "headlamp", 1], ["Cooler", "hard cooler"], ["Stove", "camping stove"], ["Gas", "butane canister"]] },
    fishing: { title: "fishing", items: [["Rod and reel combo", "spinning combo", 1], ["Braid line", "braid line"], ["Soft plastics", "soft plastic"], ["Hard body lure", "hard body lure"], ["Tackle box", "tackle box"], ["Bait", "bait"]] },
    hiking: { title: "hiking", items: [["Hiking pack", "hiking pack", 1], ["Hydration", "hydration", 1], ["Hiking boots", "hiking boot", 1], ["Rain jacket", "rain jacket", 1], ["Head torch", "headlamp", 1], ["First aid kit", "first aid kit"]] },
    beach: { title: "beach", items: [["Beach shelter", "beach tent"], ["Umbrella", "beach umbrella"], ["Beach chair", "beach chair", 1], ["Beach trolley", "beach trolley"], ["Cooler bag", "cooler bag"]] },
    kayaking: { title: "kayaking", items: [["Kayak", "kayak"], ["Life jacket", "pfd", 1], ["Dry storage", "dry bag"]] },
    "4wd": { title: "4WD", items: [["Air compressor", "air compressor"], ["Recovery gear", "recovery"], ["Driving lights", "light bar"], ["Fridge", "fridge freezer"]] },
  };
  const KIT_RE = /\b(trip|weekend|holiday|getaway|beginners?|starter|first time|what (do|should) (i|we) (need|get|bring|buy|take)|checklist|kit|set ?up|going)\b/;
  const KIT_TOPIC = [["camping", /\bcamp(ing)?\b/], ["fishing", /\bfish(ing)?\b/], ["hiking", /\b(hik(e|ing)|bushwalk(ing)?|trek(king)?)\b/],
    ["beach", /\bbeach\b/], ["kayaking", /\bkayak(ing)?\b/], ["4wd", /\b(4wd|4x4|off ?road(ing)?)\b/]];
  const ZONE_OF = { toilet: "toilets", "service desk": "service", "click and collect": "service", "fitting room": "fitting", checkout: "checkouts", trolley: "entrance" };

  function facility(qn) {
    const padded = ` ${qn} `;
    for (const f of DB.facilities || []) {
      if (f.keys.some(k => padded.includes(` ${norm(k)} `))) return { ...f, zone: ZONE_OF[f.keys[0]] };
    }
    return null;
  }

  // ---------- rendering ----------
  const money = v => v == null ? "" : "$" + (Number.isInteger(v) ? v : v.toFixed(2));
  const where = p => `Aisle ${p.aisle}, Bay ${p.bay}`;
  const stockPill = n => n <= 0 ? `<span class="pill out">Sold out here</span>`
    : n <= 3 ? `<span class="pill low">Only ${n} left</span>` : `<span class="pill ok">${n} in stock</span>`;
  const aisleLabel = n => (DB.aisles.find(a => a.n === n) || {}).label || "";

  function card(p, label = "", qty = 0) {
    const img = p.img
      ? `<img src="${esc(p.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=noimg></div>'">`
      : `<div class="noimg"></div>`;
    return `<a class="item" href="${esc(p.url)}" target="_blank" rel="noopener">${img}<div>` +
      (label ? `<span class="label">${esc(label)}</span>` : "") +
      `<span class="name">${qty > 1 ? `<span class="qty">${qty} x </span>` : ""}${esc(p.name)}</span>` +
      `<div class="meta"><span class="price">${money(p.price)}</span><span class="pill where">A${p.aisle} · B${p.bay}</span>${stockPill(p.stock)}</div></div></a>`;
  }

  function cards(list, show = 4) {
    const html = list.map(x => card(x.p, x.label, x.qty));
    let s = `<div class="items">${html.slice(0, show).join("")}</div>`;
    if (html.length > show) s += `<button class="more" type="button" data-rest="${esc(html.slice(show).join(""))}">Show ${html.length - show} more</button>`;
    return s;
  }

  // Store map: 18 aisles, entrance at the bottom, bays numbered from the front.
  const AX0 = 26, AX1 = 334, AY = 46, AH = 112, YOU = [180, 196];
  const ax = n => AX0 + (n - 1) * (AX1 - AX0) / 17;
  const bayY = b => AY + AH - (b - 0.5) * AH / 12;
  const GAP = (AX1 - AX0) / 34;
  const ZONES = {
    toilets: { x: ax(9) - 22, y: 12, w: 44, h: 16, label: "Toilets", path: `V178 H${ax(9) + GAP} V28` },
    fitting: { x: ax(17) - 30, y: 12, w: 52, h: 16, label: "Fitting rooms", path: `V178 H${ax(16) + GAP} V28` },
    checkouts: { x: 18, y: 184, w: 96, h: 20, label: "Checkouts", path: "H114" },
    service: { x: 246, y: 184, w: 96, h: 20, label: "Service desk", path: "H246" },
    entrance: { x: 150, y: 208, w: 60, h: 14, label: "Entrance", path: "" },
  };
  function mapSVG(marks = [], zone = null) {
    const on = new Set(marks.map(p => p.aisle));
    let s = `<svg viewBox="0 0 360 230" role="img" aria-label="Store map"><rect class="m-floor" width="360" height="230"/>` +
      `<path class="m-wall" d="M150 216 H8 V8 H352 V216 H210"/>`;
    for (const [a, b, t] of [[1, 7, "Camping"], [9, 12, "Fishing"], [13, 14, "Water"], [17, 18, "Apparel"]]) {
      s += `<text class="m-dept" x="${(ax(a) + ax(b)) / 2}" y="40">${t}</text>`;
    }
    for (let n = 1; n <= 18; n++) {
      const c = on.has(n) ? " on" : "";
      s += `<rect class="m-aisle${c}" x="${ax(n) - 5}" y="${AY}" width="10" height="${AH}" rx="3"/>` +
        `<text class="m-num${c}" x="${ax(n)}" y="${AY + AH + 12}">${n}</text>`;
    }
    for (const [k, z] of Object.entries(ZONES)) {
      s += `<rect class="m-zone${zone === k ? " on" : ""}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="5"/>` +
        `<text class="m-zlabel" x="${z.x + z.w / 2}" y="${z.y + z.h / 2 + 2.6}">${z.label}</text>`;
    }
    if (marks.length === 1) {
      const p = marks[0], x = ax(p.aisle), y = bayY(p.bay);
      s += `<path class="m-path" d="M${YOU[0]} ${YOU[1]} V178 H${x + GAP} V${y} H${x + 5}"/>`;
    } else if (zone && ZONES[zone].path) {
      s += `<path class="m-path" d="M${YOU[0]} ${YOU[1]} ${ZONES[zone].path}"/>`;
    }
    for (const p of marks) s += `<circle class="m-bay" cx="${ax(p.aisle)}" cy="${bayY(p.bay)}" r="5"/>`;
    s += `<circle class="m-you" cx="${YOU[0]}" cy="${YOU[1]}" r="5"/><text class="m-youlabel" x="${YOU[0] + 10}" y="${YOU[1] + 3}" style="text-anchor:start">You are here</text></svg>`;
    return `<div class="map">${s}</div>`;
  }

  // ---------- answers ----------
  function kitAnswer(topic, qn) {
    const kit = KITS[topic], n = people(qn), rows = [];
    for (const [label, query, per] of kit.items) {
      const hits = search(query, 6);
      if (!hits.length) continue;
      const pick = hits.find(h => h.p.stock > 0) || hits[0];
      rows.push({ p: pick.p, label, qty: per && n ? Math.max(1, Math.ceil(n * per)) : 1 });
    }
    const aisles = [...new Set(rows.map(r => r.p.aisle))].sort((a, b) => a - b);
    const say = `Here's a ${kit.title} starter list${n ? ` for ${n}` : ""}. It's all in store, across ${aisles.length} aisle${aisles.length > 1 ? "s" : ""}.`;
    return { say, sub: `Aisles ${aisles.join(", ")}.`, html: cards(rows, rows.length), map: mapSVG(rows.map(r => r.p)), ok: rows.length > 0 };
  }

  function productAnswer(qn, hits, q) {
    const top = hits[0].p;
    // Echo the shopper's own words ("tent pegs"), not the normalised tokens ("headlamp").
    const own = String(q).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter(w => w && !STOP.has(w) && !STOP.has(stem(w))).join(" ");
    const phrase = own || top.cat.toLowerCase();
    const aisles = [...new Set(hits.slice(0, 5).map(h => h.p.aisle))];
    const alt = top.stock > 0 ? null : (hits.find(h => h.p.stock > 0) || {}).p;
    const stockLine = top.stock > 0 ? `Top match: ${top.stock} in stock.`
      : alt ? `Top match is sold out here, but the ${alt.name} has ${alt.stock} in stock.` : "Sold out here right now. The team can check other stores.";
    let say, sub = "", marks = [top];
    if (/\b(how much|price|cost|costs)\b/.test(qn)) {
      say = `The ${top.name} is ${money(top.price)}.`;
      sub = `${where(top)}. ${top.stock > 0 ? `${top.stock} in stock.` : "Sold out here right now."}`;
    } else if (/\b(in stock|any left|available|do you (have|sell|stock)|have you got|got any)\b/.test(qn)) {
      say = top.stock > 0 ? `Yes, ${top.stock} in stock. ${where(top)}.` : `Sold out here right now. ${alt ? `The ${alt.name} is in stock, ${where(alt)}.` : ""}`;
      sub = top.stock > 0 ? top.name : "";
    } else if (aisles.length === 1) {
      say = `You'll find ${phrase} in ${where(top)}.`;
      sub = stockLine;
    } else {
      const list = aisles.slice(0, 3).map(a => `Aisle ${a} (${aisleLabel(a)})`);
      say = `${phrase.charAt(0).toUpperCase() + phrase.slice(1)}: ${list.slice(0, -1).join(", ")}${list.length > 1 ? " and " : ""}${list[list.length - 1]}.`;
      sub = stockLine;
      marks = aisles.slice(0, 3).map(a => hits.find(h => h.p.aisle === a).p);
    }
    return { say, sub, html: cards(hits.map(h => ({ p: h.p })), 4), map: mapSVG(marks), ok: true };
  }

  async function askAI(q, hits, sayEl) {
    if (!AI) return "";
    try {
      sayEl.textContent = "Thinking...";
      const res = await fetch(AI, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ store: DB.store, question: q, items: hits.slice(0, 15).map(h => ({ name: h.p.name, aisle: h.p.aisle, bay: h.p.bay, stock: h.p.stock, price: h.p.price })) }),
      });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const rd = res.body.getReader(), dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        sayEl.textContent = text;
      }
      return text.trim();
    } catch {
      return "";
    }
  }

  // ---------- conversation ----------
  const feed = $("#feed");
  const fine = document.createElement("p");
  fine.className = "fine";
  const LOGKEY = `aisle-log-${slug}`;

  function addTurn(q) {
    $("#welcome")?.remove();
    const el = document.createElement("section");
    el.className = "turn";
    el.innerHTML = `<div class="you"><span>${esc(q)}</span></div><div class="answer"><p class="say">...</p></div>`;
    feed.insertBefore(el, fine);
    return el;
  }

  async function ask(q, via = "text") {
    q = String(q || "").trim();
    if (!q || !DB) return;
    const qn = norm(q), el = addTurn(q), box = $(".answer", el), sayEl = $(".say", box);
    let r;
    const fac = facility(qn);
    const topic = KIT_RE.test(qn) ? (KIT_TOPIC.find(([, re]) => re.test(qn)) || [])[0] : null;
    if (fac) {
      r = { say: fac.answer, sub: "", html: "", map: mapSVG([], fac.zone), ok: true };
    } else if (topic) {
      r = kitAnswer(topic, qn);
    } else {
      const hits = search(q);
      const open = words(q).length >= 5 && (!hits.length || hits[0].cov < 0.6);
      if (hits.length && !open) {
        r = productAnswer(qn, hits, q);
      } else {
        const pool = hits.length ? hits : words(q).flatMap(w => search(w, 4));
        const text = await askAI(q, pool, sayEl);
        r = text ? { say: text, sub: "", html: pool.length ? cards(pool.slice(0, 6).map(h => ({ p: h.p })), 3) : "", map: "", ok: true }
          : hits.length ? productAnswer(qn, hits, q)
          : { say: "Hmm, I couldn't find that one. Try other words, or ask the team at the service desk (front right).", sub: "", html: "", map: mapSVG([], "service"), ok: false };
      }
    }
    box.innerHTML = `<p class="say">${esc(r.say)}</p>${r.sub ? `<p class="sub">${esc(r.sub)}</p>` : ""}${r.html}${r.map}`;
    const log = saved.get(LOGKEY, []);
    log.unshift({ q, ok: r.ok, t: Date.now() });
    saved.set(LOGKEY, log.slice(0, 200));
    if (via === "voice") speak(r.say);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  feed.addEventListener("click", e => {
    const more = e.target.closest(".more");
    if (more) {
      more.previousElementSibling.insertAdjacentHTML("beforeend", more.dataset.rest);
      more.remove();
    }
  });

  function staffPanel() {
    const log = saved.get(LOGKEY, []), miss = log.filter(x => !x.ok).length;
    const el = document.createElement("section");
    el.className = "staff";
    el.innerHTML = `<h2>Shopper questions on this device</h2><p class="sub">${log.length} asked, ${miss} with no answer</p>` +
      `<ol>${log.slice(0, 50).map(x => `<li${x.ok ? "" : ' class="miss"'}>${esc(x.q)}${x.ok ? "" : " (no answer)"}</li>`).join("")}</ol>`;
    feed.prepend(el);
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---------- voice ----------
  let speakOn = saved.get("aisle-speak", true);
  const speakBtn = $("#speak");
  const syncSpeak = () => {
    speakBtn.setAttribute("aria-pressed", String(speakOn));
    speakBtn.querySelector(".wave").style.opacity = speakOn ? "1" : "0.15";
  };
  speakBtn.addEventListener("click", () => {
    speakOn = !speakOn;
    saved.set("aisle-speak", speakOn);
    syncSpeak();
    if (!speakOn && "speechSynthesis" in window) speechSynthesis.cancel();
  });
  function speak(text) {
    if (!speakOn || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-AU";
    u.rate = 1.04;
    const voices = speechSynthesis.getVoices();
    const v = voices.find(x => x.lang === "en-AU") || voices.find(x => (x.lang || "").startsWith("en"));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  const setHint = t => { const h = $("#hint"); if (h) h.textContent = t; };
  function listen() {
    if (!SR) {
      toast("Voice isn't available in this browser. Try Chrome or Safari, or just type.");
      $("#q").focus();
      return;
    }
    if (rec) { rec.stop(); return; }
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    rec = new SR();
    rec.lang = "en-AU";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let heard = "";
    rec.onstart = () => { document.body.classList.add("listening"); setHint("Listening..."); };
    rec.onresult = e => {
      heard = Array.from(e.results, r => r[0].transcript).join("");
      $("#q").value = heard;
    };
    rec.onerror = e => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone is blocked. Allow mic access for this page.");
    };
    rec.onend = () => {
      rec = null;
      document.body.classList.remove("listening");
      setHint("Tap and speak");
      const t = heard.trim();
      if (t) { $("#q").value = ""; ask(t, "voice"); }
    };
    try { rec.start(); } catch { rec = null; }
  }
  $("#mic").addEventListener("click", listen);
  $("#bigMic").addEventListener("click", listen);
  $("#composer").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("#q").value;
    $("#q").value = "";
    $("#q").blur();
    ask(v, "text");
  });

  // ---------- start ----------
  async function init() {
    syncSpeak();
    if (!SR) setHint("Type below, or use Chrome or Safari for voice");
    const chips = ["tent pegs", "kids sleeping bag", "gas canister", "head torch", "where are the toilets?", "camping weekend for 4"];
    $("#chips").innerHTML = chips.map(c => `<button class="chip" type="button">${esc(c)}</button>`).join("");
    $("#chips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) ask(b.textContent); });
    try {
      let res = await fetch(`data/${slug}.json`);
      if (!res.ok) res = await fetch("data/brendale.json");
      DB = await res.json();
    } catch {
      toast("Couldn't load the store data. Check your connection and reload.");
      return;
    }
    const storeName = DB.slug === slug ? DB.store : titleCase(slug);
    $("#storeName").textContent = `Anaconda ${storeName}`;
    document.title = `Find it in store · Anaconda ${storeName}`;
    IDX = buildIndex(DB.products, DB.aisles);
    fine.textContent = `Independent demo by Max Krioutchkov, not an official Anaconda service. Products and prices from anacondastores.com (${DB.generated}); aisle, bay and stock numbers are sample data.`;
    feed.appendChild(fine);
    if (params.has("staff")) staffPanel();
    if (params.get("q")) ask(params.get("q"));
  }
  init();
})();
