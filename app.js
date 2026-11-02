"use strict";
// In-store product finder, the page side: draws what engine.js works out, handles voice in and out,
// and calls the AI for the open questions the engine hands over.
(() => {
  const params = new URLSearchParams(location.search);
  const slug = (params.get("store") || "brendale").toLowerCase().replace(/[^a-z0-9-]/g, "") || "brendale";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const titleCase = s => s.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const saved = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // A key from a private test link (#ai=<key>) wins over the demo key in config.js.
  const linkKey = new URLSearchParams(location.hash.slice(1)).get("ai");
  if (linkKey) {
    saved.set("aisle-ai-key", linkKey);
    history.replaceState(null, "", location.pathname + location.search);
  }
  const AI_KEY = saved.get("aisle-ai-key", "") || String(window.AISLE_AI_KEY || "");
  const AI_URL = String(window.AISLE_AI || "").trim() || "https://api.deepseek.com/chat/completions";
  const aiOn = !!(AI_KEY || window.AISLE_AI);
  const aiHeaders = { "content-type": "application/json", ...(AI_KEY ? { authorization: `Bearer ${AI_KEY}` } : {}) };
  // deepseek-flash with thinking off won a test of DeepSeek's models on store questions: first word
  // in 0.7-0.95s from Brisbane (pro took 1.4-1.8s, pro with thinking 7s) with answers good enough.
  const AI_MODEL = "deepseek-flash";
  const AI_FIRST_WORD_MS = 6000, AI_TOTAL_MS = 12000;

  const PRODUCT_BASE = "https://www.anacondastores.com/en-au/p/", IMG_BASE = "https://www.anacondastores.com/medias/";
  let DB = null, engine = null, IMG = null, lastWarm = 0, markReady;
  // A question asked while the catalogue is still loading waits for it rather than vanishing.
  const whenReady = new Promise(resolve => { markReady = resolve; });

  // ---------- rendering ----------
  const money = v => v == null ? "" : "$" + (Number.isInteger(v) ? v : v.toFixed(2));
  const stockPill = n => n <= 0 ? `<span class="pill out">Sold out here</span>`
    : n <= 3 ? `<span class="pill low">Only ${n} left</span>` : `<span class="pill ok">${n} in stock</span>`;

  function imgTag(p) {
    const fail = `onerror="this.outerHTML='<div class=noimg></div>'"`;
    if (IMG && IMG[p.id]) return `<img src="${esc(IMG_BASE + IMG[p.id])}" alt="" loading="lazy" referrerpolicy="no-referrer" ${fail}>`;
    return IMG ? `<div class="noimg"></div>` : `<img data-id="${esc(p.id)}" alt="" referrerpolicy="no-referrer" ${fail} class="noimg">`;
  }

  function card(p, label = "", qty = 0) {
    return `<a class="item" href="${esc(PRODUCT_BASE + p.url)}" target="_blank" rel="noopener">${imgTag(p)}<div>` +
      (label ? `<span class="label">${esc(label)}</span>` : "") +
      `<span class="name">${qty > 1 ? `<span class="qty">${qty} x </span>` : ""}${esc(p.name)}</span>` +
      `<div class="meta"><span class="price">${money(p.price)}</span><span class="pill where">A${p.aisle} · B${p.bay}</span>${stockPill(p.stock)}</div></div></a>`;
  }

  function cards(list, show = 4) {
    if (!list || !list.length) return "";
    const html = list.map(x => card(x.p, x.label, x.qty));
    let s = `<div class="items">${html.slice(0, show).join("")}</div>`;
    if (html.length > show) s += `<button class="more" type="button" data-rest="${esc(html.slice(show).join(""))}">Show ${html.length - show} more</button>`;
    return s;
  }

  // Store map: aisles left to right, entrance at the bottom, bays numbered from the front.
  const AX0 = 22, AX1 = 338, AY = 46, AH = 112, YOU = [180, 196];
  const step = () => (AX1 - AX0) / (DB.aisles.length - 1);
  const ax = n => AX0 + (n - 1) * step();
  const bayY = b => AY + AH - (b - 0.5) * AH / 12;
  function zones() {
    const gap = step() / 2, fit = DB.aisles.find(a => a.dept === "Apparel") || DB.aisles[DB.aisles.length - 2];
    return {
      toilets: { x: ax(9) - 22, y: 12, w: 44, h: 16, label: "Toilets", path: `V178 H${ax(9) + gap} V28` },
      fitting: { x: ax(fit.n) - 26, y: 12, w: 52, h: 16, label: "Fitting rooms", path: `V178 H${ax(fit.n) - gap} V28` },
      checkouts: { x: 18, y: 184, w: 96, h: 20, label: "Checkouts", path: "H114" },
      service: { x: 246, y: 184, w: 96, h: 20, label: "Service desk", path: "H246" },
      entrance: { x: 150, y: 208, w: 60, h: 14, label: "Entrance", path: "" },
    };
  }
  function mapSVG(marks = [], zone = null, walk = false) {
    const on = new Set(marks.map(p => p.aisle)), Z = zones(), gap = step() / 2, width = Math.min(10, step() * 0.6);
    let s = `<svg viewBox="0 0 360 230" role="img" aria-label="Store map"><rect class="m-floor" width="360" height="230"/>` +
      `<path class="m-wall" d="M150 216 H8 V8 H352 V216 H210"/>`;
    const groups = [];
    for (const a of DB.aisles) {
      const g = groups[groups.length - 1];
      if (g && g.dept === a.dept) g.to = a.n; else groups.push({ dept: a.dept, from: a.n, to: a.n });
    }
    for (const g of groups) if (g.to - g.from >= 2) s += `<text class="m-dept" x="${(ax(g.from) + ax(g.to)) / 2}" y="40">${esc(g.dept)}</text>`;
    for (const a of DB.aisles) {
      const c = on.has(a.n) ? " on" : "";
      s += `<rect class="m-aisle${c}" x="${ax(a.n) - width / 2}" y="${AY}" width="${width}" height="${AH}" rx="3"/>` +
        `<text class="m-num${c}" x="${ax(a.n)}" y="${AY + AH + 12}">${a.n}</text>`;
    }
    for (const [k, z] of Object.entries(Z)) {
      s += `<rect class="m-zone${zone === k ? " on" : ""}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="5"/>` +
        `<text class="m-zlabel" x="${z.x + z.w / 2}" y="${z.y + z.h / 2 + 2.6}">${z.label}</text>`;
    }
    if (marks.length > 1 && walk) {
      // A shopping list: along the front of the aisles, up to each stop and back, in aisle order.
      const stops = [...marks].sort((p, q) => p.aisle - q.aisle || p.bay - q.bay);
      s += `<path class="m-path" d="M${YOU[0]} ${YOU[1]} V178 ${stops.map(p => `H${ax(p.aisle) + gap} V${bayY(p.bay)} V178`).join(" ")}"/>`;
    } else if (marks.length === 1) {
      const p = marks[0], x = ax(p.aisle), y = bayY(p.bay);
      s += `<path class="m-path" d="M${YOU[0]} ${YOU[1]} V178 H${x + gap} V${y} H${x + width / 2}"/>`;
    } else if (zone && Z[zone] && Z[zone].path) {
      s += `<path class="m-path" d="M${YOU[0]} ${YOU[1]} ${Z[zone].path}"/>`;
    }
    for (const p of marks) s += `<circle class="m-bay" cx="${ax(p.aisle)}" cy="${bayY(p.bay)}" r="5"/>`;
    s += `<circle class="m-you" cx="${YOU[0]}" cy="${YOU[1]}" r="5"/><text class="m-youlabel" x="${YOU[0] + 10}" y="${YOU[1] + 3}" style="text-anchor:start">You are here</text></svg>`;
    return `<div class="map">${s}</div>`;
  }

  // ---------- AI ----------
  // The key header forces a CORS preflight (about 0.4s to DeepSeek) and browsers only remember it for
  // about 5 seconds. Send a throwaway request when the shopper starts asking (mic tap, typing) so the
  // real one skips it. An empty body is rejected before any model runs, so it costs nothing.
  function warmAI() {
    if (!AI_KEY || performance.now() - lastWarm < 4000) return;
    lastWarm = performance.now();
    fetch(AI_URL, { method: "POST", headers: aiHeaders, body: "{}" }).catch(() => {});
  }

  async function askAI(messages, sayEl) {
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), AI_FIRST_WORD_MS);
    const t0 = performance.now();
    let first = 0, raw = "";
    try {
      const res = await fetch(AI_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: aiHeaders,
        body: JSON.stringify({ model: AI_MODEL, thinking: { type: "disabled" }, stream: true, max_tokens: 200, messages }),
      });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const rd = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          const piece = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;
          if (!piece) continue;
          if (!first) {
            first = performance.now() - t0;
            clearTimeout(timer);
            timer = setTimeout(() => ctrl.abort(), AI_TOTAL_MS);
            sayEl.classList.remove("wait");
          }
          raw += piece;
          const cut = raw.indexOf("[");
          sayEl.textContent = (cut < 0 ? raw : raw.slice(0, cut)).trim();
        }
      }
      return raw.trim() ? { raw, first, total: performance.now() - t0 } : null;
    } catch (e) {
      console.warn("AI unavailable:", e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- conversation ----------
  const feed = $("#feed");
  const LOGKEY = `aisle-log-${slug}`;

  function addTurn(q) {
    $("#welcome")?.remove();
    const el = document.createElement("section");
    el.className = "turn";
    el.innerHTML = `<div class="you"><span>${esc(q)}</span></div><div class="answer"><p class="say">...</p></div>`;
    feed.appendChild(el);
    return el;
  }

  async function ask(q, via = "text") {
    q = String(q || "").trim();
    if (!q) return;
    const el = addTurn(q), box = $(".answer", el), sayEl = $(".say", box);
    await whenReady;
    let r = engine.route(q, { voice: via === "voice" });
    if (r.ai) {
      const { pool, fallback } = r, asked = r.q || q, note = /^Showing /.test(fallback.sub || "") ? fallback.sub.split(/(?<=\.)\s/)[0] : "";
      r = fallback;
      if (aiOn) {
        sayEl.classList.add("wait");
        const a = await askAI(engine.aiMessages(asked, pool), sayEl);
        if (a) {
          r = engine.aiAnswer(a.raw, pool);
          const timing = params.has("debug") ? `First word ${(a.first / 1000).toFixed(1)}s, full answer ${(a.total / 1000).toFixed(1)}s` : "";
          r.sub = [note, timing].filter(Boolean).join(" ");
        }
      }
    }
    box.innerHTML = `<p class="say">${esc(r.say)}</p>${r.sub ? `<p class="sub">${esc(r.sub)}</p>` : ""}${cards(r.items, r.show || 4)}` +
      (r.marks.length || r.zone ? mapSVG(r.marks, r.zone, r.walk) : "");
    fillImages(box);
    engine.log(q, r);
    const log = saved.get(LOGKEY, []);
    log.unshift({ q, ok: r.ok, t: Date.now() });
    saved.set(LOGKEY, log.slice(0, 200));
    if (via === "voice") speak(r.say);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Photos come in a separate file so the catalogue itself loads fast on a weak signal.
  function fillImages(root) {
    if (!IMG) return;
    for (const img of root.querySelectorAll("img[data-id]")) {
      const tail = IMG[img.dataset.id];
      img.removeAttribute("data-id");
      img.classList.remove("noimg");
      if (tail) img.src = IMG_BASE + tail; else img.classList.add("noimg");
    }
  }

  feed.addEventListener("click", e => {
    const more = e.target.closest(".more");
    if (more) {
      more.previousElementSibling.insertAdjacentHTML("beforeend", more.dataset.rest);
      more.remove();
      fillImages(feed);
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
    // Spec strings are fine to read on a card but not to hear: 5'6" 3pc 8-10kg.
    const u = new SpeechSynthesisUtterance(text.replace(/\s*\b\d+'\d*"?|\s*\b\d+pc\b|\s*\b\d+(?:-\d+)?(?:kg|cm|mm)\b(?:\/\d+in)?/gi, ""));
    u.lang = "en-AU";
    u.rate = 1.04;
    const voices = speechSynthesis.getVoices();
    const v = voices.find(x => x.lang === "en-AU") || voices.find(x => (x.lang || "").startsWith("en"));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  // iPhones only allow speech once it has been started from a tap.
  let speechUnlocked = false;
  function unlockSpeech() {
    if (speechUnlocked || !("speechSynthesis" in window)) return;
    speechUnlocked = true;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
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
    unlockSpeech();
    warmAI();
    rec = new SR();
    rec.lang = "en-AU";
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    let heard = "", sent = false;
    const send = () => {
      const t = heard.trim();
      if (t && !sent) { sent = true; $("#q").value = ""; ask(t, "voice"); }
    };
    rec.onstart = () => { document.body.classList.add("listening"); setHint("Listening..."); };
    rec.onresult = e => {
      heard = Array.from(e.results, r => r[0].transcript).join("");
      $("#q").value = heard;
      warmAI();
      // Answer on the final transcript straight away instead of waiting for the recogniser to wind down,
      // using whichever of its guesses the catalogue can make sense of.
      const end = e.results[e.results.length - 1];
      if (end.isFinal) {
        const before = Array.from(e.results).slice(0, -1).map(r => r[0].transcript).join("");
        if (engine) heard = before + engine.bestHeard(Array.from(end, alt => alt.transcript));
        send();
        rec.stop();
      }
    };
    rec.onerror = e => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone is blocked. Allow mic access for this page.");
    };
    rec.onend = () => {
      rec = null;
      document.body.classList.remove("listening");
      setHint("Tap and speak");
      send();
    };
    try { rec.start(); } catch { rec = null; }
  }
  $("#q").addEventListener("focus", warmAI);
  $("#q").addEventListener("input", warmAI);
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
    const chips = ["tent pegs", "kids sleeping bag", "gas canister", "head torch", "cheapest fishing rod", "where are the toilets?", "camping weekend for 4"];
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
    fetch(`data/${DB.slug}-img.json`).then(r => r.json()).then(m => { IMG = m; fillImages(feed); }).catch(() => { IMG = {}; });
    const storeName = DB.slug === slug ? DB.store : titleCase(slug);
    $("#storeName").textContent = `Anaconda ${storeName}`;
    document.title = `Find it in store · Anaconda ${storeName}`;
    engine = window.createAisleEngine(DB);
    markReady();
    if (aiOn) {
      const link = Object.assign(document.createElement("link"), { rel: "preconnect", href: new URL(AI_URL).origin, crossOrigin: "anonymous" });
      document.head.appendChild(link);
    }
    if (params.has("staff")) staffPanel();
    if (params.get("q")) ask(params.get("q"));
  }
  init();
})();
