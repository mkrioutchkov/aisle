"use strict";
// The store's report: what shoppers ask, what they couldn't find, and when. Everything a shopper typed goes in as
// text, never as HTML, because anyone can ask anything.
(() => {
  const API = String(window.AISLE_API || "");
  const REFRESH_MS = 15000;
  const $ = s => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const post = body => fetch(API, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
  const remembered = {
    get() { try { return sessionStorage.getItem("aisle-report") || ""; } catch { return ""; } },
    set(v) { try { sessionStorage.setItem("aisle-report", v); } catch { /* private mode */ } },
  };
  const count = n => Number(n || 0).toLocaleString("en-AU");
  const compact = n => (n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n));
  const dayLabel = (d, opts) => new Date(`${d}T12:00:00`).toLocaleDateString("en-AU", opts);
  const hourLabel = h => `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
  const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
  const brisbaneTime = at => new Date(at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" });
  const niceMax = v => {
    if (v <= 5) return 5;
    const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  };

  // ---------- tooltip ----------
  const tip = $("#tip");
  function showTip(x, y, value, label) {
    tip.replaceChildren(el("b", "", value), document.createTextNode(label));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2))}px`;
    tip.style.top = `${Math.max(8, y - r.height - 10)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- charts ----------
  function bars(box, rows, total, none) {
    box.replaceChildren();
    if (!rows.length) { box.append(el("p", "empty", none)); return; }
    const biggest = Math.max(...rows.map(r => r.n));
    for (const r of rows) {
      const row = el("div", "bar-row"), track = el("div", "bar-track"), bar = el("i");
      // Leaves room for the number at the end of the longest bar.
      bar.style.width = `${(r.n / biggest) * 86}%`;
      track.append(bar, el("b", "", count(r.n)));
      row.append(el("div", "bar-q", r.question), track);
      row.addEventListener("pointermove", e => {
        if (e.pointerType === "mouse") showTip(e.clientX, e.clientY, `${count(r.n)} times`, `${((r.n / total) * 100).toFixed(1)}% of all questions`);
      });
      row.addEventListener("pointerleave", hideTip);
      box.append(row);
    }
  }

  // Columns with one hover readout. Points at whichever column is nearest, so nobody has to land on a thin one.
  function columns(box, rows, { title, unit, first, last }) {
    box.replaceChildren();
    if (!rows.length) { box.append(el("p", "empty", "No questions in this period.")); return; }
    const peak = rows.reduce((a, b) => (b.n > a.n ? b : a), rows[0]), top = niceMax(peak.n);
    const chart = el("div", "chart"), plot = el("div", "plot"), cols = el("div", "cols");
    chart.tabIndex = 0;
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", `${title}. Busiest was ${peak.label} with ${count(peak.n)} ${unit}. Use left and right arrows to read each one, or open the table below.`);
    for (const [value, at] of [[top, 100], [top / 2, 50], [0, 0]]) {
      const tick = el("div", at ? "tick" : "tick zero");
      tick.style.bottom = `${at}%`;
      tick.append(el("span", "", compact(value)));
      plot.append(tick);
    }
    cols.style.gridTemplateColumns = `repeat(${rows.length}, minmax(0, 1fr))`;
    for (const r of rows) {
      const col = el("div", "col"), mark = el("i");
      mark.style.height = `${(r.n / top) * 100}%`;
      col.append(mark);
      cols.append(col);
    }
    plot.append(cols);
    const axis = el("div", "xaxis");
    axis.append(el("span", "", first), el("span", "", last));
    chart.append(plot, axis);

    let at = -1;
    const pick = i => {
      if (at >= 0) cols.children[at].classList.remove("on");
      at = i;
      cols.children[i].classList.add("on");
      const box = cols.children[i].getBoundingClientRect(), plotBox = plot.getBoundingClientRect();
      showTip(box.left + box.width / 2, plotBox.top, `${count(rows[i].n)} ${unit}`, rows[i].label);
    };
    const leave = () => { if (at >= 0) cols.children[at].classList.remove("on"); at = -1; hideTip(); };
    plot.addEventListener("pointermove", e => {
      const b = plot.getBoundingClientRect();
      pick(Math.max(0, Math.min(rows.length - 1, Math.floor(((e.clientX - b.left) / b.width) * rows.length))));
    });
    plot.addEventListener("pointerleave", leave);
    plot.addEventListener("pointercancel", leave);
    chart.addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      pick(at < 0 ? rows.indexOf(peak) : Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowLeft" ? -1 : 1))));
    });
    chart.addEventListener("blur", leave);

    const details = el("details"), table = el("table"), head = el("tr");
    head.append(el("th", "", title.split(" per ")[1] ? "Day" : "Hour"), el("th", "", "Questions"));
    table.append(head);
    for (const r of rows) {
      const tr = el("tr");
      tr.append(el("td", "", r.label), el("td", "", count(r.n)));
      table.append(tr);
    }
    details.append(el("summary", "", "Show as a table"), table);
    box.append(chart, details);
  }

  // ---------- the report ----------
  function tile(label, value, small) {
    const t = el("div", "tile");
    t.append(el("div", "label", label), el("div", "value", value), el("div", "small", small));
    return t;
  }

  function fillDays(rows, days) {
    const byDay = new Map(rows.map(r => [r.day, r.n])), out = [];
    const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Australia/Brisbane" }));
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push({ day: key, n: byDay.get(key) || 0, label: dayLabel(key, { weekday: "short", day: "numeric", month: "short" }) });
    }
    return out;
  }

  function fillHours(rows) {
    if (!rows.length) return [];
    const byHour = new Map(rows.map(r => [r.hour, r.n])), hours = rows.map(r => r.hour), out = [];
    for (let h = Math.min(...hours); h <= Math.max(...hours); h++) out.push({ hour: h, n: byHour.get(h) || 0, label: hourLabel(h) });
    return out;
  }

  function draw(d) {
    const note = $("#sampleNote");
    note.hidden = !d.sample;
    note.textContent = `Demo data: ${count(d.sample)} of these questions are generated, so the report has something to show. Only "Just asked" is real.`;

    const answered = d.total ? Math.round(((d.total - d.unanswered) / d.total) * 100) : 0;
    $("#tiles").replaceChildren(
      tile("Questions", count(d.total), `over ${d.days} days`),
      tile("Shoppers", count(d.sessions), d.sessions ? `${(d.total / d.sessions).toFixed(1)} questions each` : ""),
      tile("Answered", `${answered}%`, `${count(d.unanswered)} couldn't be`),
      d.real_answers
        ? tile("Answer speed", d.instant_ms != null ? seconds(d.instant_ms) : "-", `${d.ai_first_ms != null ? `AI starts in ${seconds(d.ai_first_ms)}, ` : ""}real questions`)
        : tile("Answer speed", "-", "from real questions, none yet"),
    );

    bars($("#gaps"), d.gaps, d.total, "Nothing unanswered in this period.");
    bars($("#top"), d.top, d.total, "No questions in this period.");

    const days = fillDays(d.by_day, d.days), hours = fillHours(d.by_hour);
    columns($("#byDay"), days, { title: "Questions per day", unit: "questions", first: dayLabel(days[0].day, { day: "numeric", month: "short" }), last: dayLabel(days[days.length - 1].day, { day: "numeric", month: "short" }) });
    columns($("#byHour"), hours, { title: "Questions by hour", unit: "questions", first: hours[0] ? hourLabel(hours[0].hour) : "", last: hours.length ? hourLabel(hours[hours.length - 1].hour) : "" });

    const live = $("#live");
    live.replaceChildren();
    if (!d.live.length) live.append(el("li", "empty", "Nothing yet. Ask something on a phone and it shows here within a few seconds."));
    for (const q of d.live) {
      const li = el("li"), asked = el("div", "asked", q.question);
      asked.append(el("span", "where", `Anaconda ${q.store.replace(/\b\w/g, c => c.toUpperCase())}`));
      li.append(el("span", "when", brisbaneTime(q.at)), asked,
        el("span", q.answered ? "tag" : "tag none", !q.answered ? "No answer" : q.route === "ai" ? `AI ${seconds(q.first_ms)}` : `Instant ${seconds(q.first_ms)}`));
      live.append(li);
    }
    $("#foot").textContent = d.stock_updated ? `Sample stock last changed ${brisbaneTime(d.stock_updated)}. This page keeps itself up to date.` : "";
  }

  let password = "", last = "";
  async function load({ quiet = false } = {}) {
    if (!quiet) $("#report").classList.add("busy");
    try {
      const res = await post({ action: "report", password, store: $("#store").value || null, days: +$("#days").value });
      if (res.status === 401) { lock(password ? "That password didn't work." : ""); return; }
      if (!res.ok) { $("#gateError").textContent = "The report didn't load just then. Try again in a moment."; return; }
      const text = await res.text();
      if (text !== last) { last = text; draw(JSON.parse(text)); }
      $("#gate").hidden = true;
      $("#report").hidden = false;
      remembered.set(password);
    } catch {
      // Keeps showing the last report. With nothing on screen yet, say why.
      $("#gateError").textContent = "The report didn't load just then. Try again in a moment.";
    } finally {
      $("#report").classList.remove("busy");
    }
  }

  function lock(message) {
    password = "";
    remembered.set("");
    last = "";
    $("#report").hidden = true;
    $("#gate").hidden = false;
    $("#gateError").textContent = message;
    $("#password").focus();
  }

  $("#gate").addEventListener("submit", e => {
    e.preventDefault();
    password = $("#password").value;
    load();
  });
  $("#store").addEventListener("change", () => load());
  $("#days").addEventListener("change", () => load());
  setInterval(() => { if (password && !document.hidden) load({ quiet: true }); }, REFRESH_MS);
  addEventListener("scroll", hideTip, { passive: true });

  post({ action: "init" }).then(r => r.json()).then(d => {
    for (const s of d.stores || []) {
      const o = el("option", "", s.name);
      o.value = s.slug;
      $("#store").append(o);
    }
  }).catch(() => {});
  password = remembered.get();
  if (password) load();
  else lock("");
})();
