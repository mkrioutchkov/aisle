"use strict";
// In-store product finder, the page side: sends each question to the server, draws the answer as it streams in,
// and handles voice in and out. The catalogue, the search, the stock and the AI key are all on the server.
(() => {
  const params = new URLSearchParams(location.search);
  const slug = (params.get("store") || "brendale").toLowerCase().replace(/[^a-z0-9-]/g, "") || "brendale";
  const API = String(window.AISLE_API || "");
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const titleCase = s => s.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const saved = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const session = (() => {
    let id = saved.get("aisle-session", "");
    if (!id) { id = Math.random().toString(36).slice(2, 12); saved.set("aisle-session", id); }
    return id;
  })();

  // What the phone remembers between questions: the last subject, for "got anything cheaper?", and the last two
  // exchanges, for the AI. The server keeps nothing per shopper, so any server instance can answer.
  let ctx = null, aisles = null;
  const chat = [];
  const post = body => fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
  // A hiccup on the way to the server shouldn't cost the shopper an answer, so it's tried once more. The hosting
  // gateway turns requests away for about a second if a burst arrives together, and says so with a 429.
  const RETRY_MS = 400, BUSY_RETRY_MS = 1100;
  const postTwice = async body => {
    const res = await post(body).catch(() => null);
    if (res && (res.ok || (res.status < 500 && res.status !== 429))) return res;
    await new Promise(done => setTimeout(done, res && res.status === 429 ? BUSY_RETRY_MS : RETRY_MS));
    return post(body);
  };
  const ready = postTwice({ action: "init" }).then(r => r.json()).then(d => {
    aisles = d.aisles;
    const store = (d.stores || []).find(s => s.slug === slug);
    if (store) showStore(store.name);
    return d;
  }).catch(() => null);

  function showStore(name) {
    $("#storeName").textContent = `Anaconda ${name}`;
    document.title = `Find it in store · Anaconda ${name}`;
  }

  // ---------- rendering ----------
  const money = v => v == null ? "" : "$" + (Number.isInteger(+v) ? +v : (+v).toFixed(2));
  const stockPill = n => n <= 0 ? `<span class="pill out">Sold out here</span>`
    : n <= 3 ? `<span class="pill low">Only ${n} left</span>` : `<span class="pill ok">${n} in stock</span>`;

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
    if (!list || !list.length) return "";
    const html = list.map(x => card(x.p, x.label, x.qty));
    let s = `<div class="items">${html.slice(0, show).join("")}</div>`;
    if (html.length > show) s += `<button class="more" type="button" data-rest="${esc(html.slice(show).join(""))}">Show ${html.length - show} more</button>`;
    return s;
  }

  // Store map: aisles left to right, entrance at the bottom, bays numbered from the front. A sign's QR can say
  // where it hangs (&at=6 for aisle 6) so "You are here" is right; without that it's the entrance.
  const AX0 = 22, AX1 = 338, AY = 46, AH = 112;
  const step = () => (AX1 - AX0) / (aisles.length - 1);
  const ax = n => AX0 + (n - 1) * step();
  const bayY = b => AY + AH - (b - 0.5) * AH / 12;
  const atAisle = parseInt(params.get("at") || "", 10);
  const start = () => (atAisle >= 1 && atAisle <= aisles.length ? [ax(atAisle) + step() / 2, 178] : [180, 196]);
  function zones() {
    const gap = step() / 2, fit = aisles.find(a => a.dept === "Apparel") || aisles[aisles.length - 2];
    return {
      toilets: { x: ax(9) - 22, y: 12, w: 44, h: 16, label: "Toilets", path: `V178 H${ax(9) + gap} V28` },
      fitting: { x: ax(fit.n) - 26, y: 12, w: 52, h: 16, label: "Fitting rooms", path: `V178 H${ax(fit.n) - gap} V28` },
      checkouts: { x: 18, y: 184, w: 96, h: 20, label: "Checkouts", path: "V194 H114" },
      service: { x: 246, y: 184, w: 96, h: 20, label: "Service desk", path: "V194 H246" },
      entrance: { x: 150, y: 208, w: 60, h: 14, label: "Entrance", path: "" },
    };
  }
  function mapSVG(marks = [], zone = null, walk = false) {
    if (!aisles) return "";
    const on = new Set(marks.map(p => p.aisle)), Z = zones(), gap = step() / 2, width = Math.min(10, step() * 0.6), YOU = start();
    let s = `<svg viewBox="0 0 360 230" role="img" aria-label="Store map"><rect class="m-floor" width="360" height="230"/>` +
      `<path class="m-wall" d="M150 216 H8 V8 H352 V216 H210"/>`;
    const groups = [];
    for (const a of aisles) {
      const g = groups[groups.length - 1];
      if (g && g.dept === a.dept) g.to = a.n; else groups.push({ dept: a.dept, from: a.n, to: a.n });
    }
    for (const g of groups) if (g.to - g.from >= 2) s += `<text class="m-dept" x="${(ax(g.from) + ax(g.to)) / 2}" y="40">${esc(g.dept)}</text>`;
    for (const a of aisles) {
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

  // ---------- conversation ----------
  const feed = $("#feed");

  function addTurn(q) {
    $("#welcome")?.remove();
    const el = document.createElement("section");
    el.className = "turn";
    el.innerHTML = `<div class="you"><span>${esc(q)}</span></div><div class="answer"><p class="say wait">...</p></div>`;
    feed.appendChild(el);
    return el;
  }

  async function ask(q, via = "text", alts = null) {
    q = String(q || "").trim();
    if (!q) return;
    const el = addTurn(q), box = $(".answer", el), sayEl = $(".say", box), t0 = performance.now();
    let answer = null, firstAt = 0, text = "";
    try {
      const res = await postTwice({ q, alts, store: slug, voice: via === "voice", ctx, chat, session });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const rd = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      const onLine = line => {
        if (!line.trim()) return;
        const ev = JSON.parse(line);
        if (ev.type === "status") {
          sayEl.textContent = ev.text;
        } else if (ev.type === "delta") {
          if (!firstAt) { firstAt = performance.now() - t0; sayEl.classList.remove("wait"); }
          text += ev.text;
          sayEl.textContent = text;
        } else if (ev.type === "answer") {
          answer = ev;
        }
      };
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      onLine(buf);
    } catch (e) {
      console.warn("Couldn't reach the server:", e.message);
    }
    // Cut off part way through: what's already arrived is still worth keeping.
    if (!answer && text) answer = { say: text, sub: "", items: [], marks: [], ok: false };
    if (!answer) answer = { say: "I can't reach the store system right now. Check your signal and try again, or ask the team at the service desk.", sub: "", items: [], marks: [], zone: "service", ok: false };
    await ready;
    const total = performance.now() - t0;
    const timing = params.has("debug") ? `${firstAt ? `First word ${(firstAt / 1000).toFixed(1)}s, full answer` : "Answer"} ${(total / 1000).toFixed(firstAt ? 1 : 2)}s${answer.route ? ` (${answer.route})` : ""}` : "";
    const sub = [answer.sub, timing].filter(Boolean).join(" ");
    box.innerHTML = `<p class="say">${esc(answer.say)}</p>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}${cards(answer.items, answer.show || 4)}` +
      ((answer.marks || []).length || answer.zone ? mapSVG(answer.marks || [], answer.zone, answer.walk) : "");
    if (answer.ctx) ctx = answer.ctx;
    chat.push({ q: answer.heard || q, say: answer.say, ok: !!answer.ok });
    if (chat.length > 2) chat.shift();
    if (via === "voice") speak(answer.say);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  feed.addEventListener("click", e => {
    const more = e.target.closest(".more");
    if (more) {
      more.previousElementSibling.insertAdjacentHTML("beforeend", more.dataset.rest);
      more.remove();
    }
  });

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
    rec = new SR();
    rec.lang = "en-AU";
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    let heard = "", guesses = null, sent = false;
    const send = () => {
      const t = heard.trim();
      if (t && !sent) { sent = true; $("#q").value = ""; ask(t, "voice", guesses); }
    };
    rec.onstart = () => { document.body.classList.add("listening"); setHint("Listening..."); };
    rec.onresult = e => {
      heard = Array.from(e.results, r => r[0].transcript).join("");
      $("#q").value = heard;
      // Answer on the final transcript straight away instead of waiting for the recogniser to wind down. The
      // server gets all of its guesses and takes the first the catalogue can make sense of.
      const end = e.results[e.results.length - 1];
      if (end.isFinal) {
        const before = Array.from(e.results).slice(0, -1).map(r => r[0].transcript).join("");
        guesses = Array.from(end, alt => before + alt.transcript);
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
  showStore(titleCase(slug));
  syncSpeak();
  if (!SR) setHint("Type below, or use Chrome or Safari for voice");
  const chips = ["tent pegs", "kids sleeping bag", "gas canister", "head torch", "cheapest fishing rod", "where are the toilets?", "camping weekend for 4"];
  $("#chips").innerHTML = chips.map(c => `<button class="chip" type="button">${esc(c)}</button>`).join("");
  $("#chips").addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) ask(b.textContent); });
  if (params.get("q")) ask(params.get("q"));
})();
