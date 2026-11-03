// The one server endpoint the phone talks to. Questions arrive as a plain-text POST so the browser skips its
// CORS preflight, and answers stream back as one JSON object per line. Holds the AI key; the phone never sees it.
import { createEngine } from "./engine.mjs";
import { SNAPSHOT } from "./snapshot.mjs";
import { aiPlan, aiWords, anthropic, deepseek } from "./stream.mjs";
import { words } from "./text.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AI_KEY = Deno.env.get("AISLE_AI_KEY") || "";
const REPORT_PASSWORD = Deno.env.get("AISLE_REPORT_PASSWORD") || "";
const AI_MODEL = "deepseek-flash";
// Optional: with an Anthropic key set as this secret, Claude takes over when DeepSeek stalls or refuses.
const AI_BACKUP_KEY = Deno.env.get("AISLE_AI_BACKUP_KEY") || "";
const AI_BACKUP_MODEL = "claude-haiku-5-5";
const AI_SERVICES: any[] = [
  AI_KEY && deepseek({ key: AI_KEY, model: AI_MODEL }),
  AI_BACKUP_KEY && anthropic({ key: AI_BACKUP_KEY, model: AI_BACKUP_MODEL }),
].filter(Boolean);
const AI_DAILY_CAP = 3000;
const AI_FIRST_WORD_MS = 7000, AI_TRY_MS = 3500, AI_STALL_MS = 2000, AI_TOTAL_MS = 12000, AI_MAX_TOKENS = 200;
// With a backup to turn to, DeepSeek gets less time to plan, so there's time left for the answer.
const PLAN_MS = AI_SERVICES.length > 1 ? [2500, 2000] : [4000];
const RATE_PER_MINUTE = 60;
const ALLOWED = [/^https:\/\/mkrioutchkov\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

const rpc = async (name: string, args: unknown) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  // A database function that returns nothing comes back with an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const inBackground = (job: Promise<unknown>) => {
  // @ts-ignore EdgeRuntime exists on the host
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job);
};

const db = {
  find: (args: unknown) => rpc("find_products", args),
  counts: (sets: unknown) => rpc("count_matches", { p_sets: sets }),
  named: (args: unknown) => rpc("find_named", args),
};

// The word list and store layout change only with the catalogue. The host replaces a worker about every 75 seconds,
// however busy it is, and fetching them cost each new worker about 0.4 s, paid by whichever shopper asked next. So a
// new worker starts from the copy built into this function (scripts/make_snapshot.mjs), and the server's own ping
// fetches the current one, when no shopper is waiting on it.
const INFO_MAX_AGE_MS = 900000;
let infoCache: any = null, infoAt = 0;
function buildInfo(raw: any, wordRows: any[]) {
  raw.wordList = wordRows.map((w: any) => ({ v: w[0], df: w[1], head: w[2], cat: w[3], s: w[4], c: w[5] }));
  raw.words = new Map(raw.wordList.map((w: any) => [w.v, w]));
  raw.wordList = raw.wordList.filter((w: any) => w.v.length >= 3 && /^[a-z]+$/.test(w.v));
  raw.labels = Object.fromEntries(raw.aisles.map((a: any) => [a.n, a.label]));
  // Neighbouring words in what the store calls its products, the test for a corrected phrase being a real thing.
  raw.pairs = new Set(raw.terms.flatMap((t: string) => words(t).map((w: string, i: number, all: string[]) => `${all[i - 1]} ${w}`).slice(1)));
  raw.storeName = (slug: string) => (raw.stores.find((s: any) => s.slug === slug) || { name: slug.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) }).name;
  return raw;
}
async function refreshInfo() {
  if (Date.now() - infoAt < INFO_MAX_AGE_MS) return;
  infoAt = Date.now();
  const [raw, wordRows] = await Promise.all([rpc("store_info", {}), rpc("all_words", {})]);
  infoCache = buildInfo(raw, wordRows);
}
function loadInfo() {
  if (!infoCache) infoCache = buildInfo(SNAPSHOT.info, SNAPSHOT.words);
  return infoCache;
}
// Takes a small question the whole way through: the worker's code, its connection to the database and a database
// connection. Whoever asks next finds them ready.
const warmUp = (info: any) => createEngine(db, info, "brendale").route("tent pegs", { voice: false, ctx: null }).catch((e: unknown) => console.warn("warm failed", String(e)));

const hits = new Map<string, number[]>();
function tooMany(ip: string, limit: number) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > limit;
}

Deno.serve(async req => {
  const origin = req.headers.get("origin") || "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": ALLOWED.some(re => re.test(origin)) ? origin : "https://mkrioutchkov.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (origin && !ALLOWED.some(re => re.test(origin))) return json({ error: "not allowed" }, 403);

  const t0 = performance.now();
  let body: any;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: "bad request" }, 400);
  }
  // The server's own timer, so a worker is often already up and connected when a shopper asks.
  if (body.action === "ping") {
    await warmUp(loadInfo());
    inBackground(refreshInfo().catch(e => console.warn("info refresh failed", String(e))));
    return json({ ok: true });
  }
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  // A dry run never reaches the AI, so it costs little and is counted apart: tests use it to check answers.
  if (body.dry ? tooMany(`dry ${ip}`, RATE_PER_MINUTE * 20) : tooMany(ip, RATE_PER_MINUTE)) return json({ error: "too many requests" }, 429);

  const info = loadInfo();
  // The page sends one of these when it opens and when a shopper touches the screen: a question is seconds away.
  if (body.action === "warm") {
    await warmUp(info);
    return json({ ok: true });
  }
  if (body.action === "init") {
    inBackground(warmUp(info));
    return json({ aisles: info.aisles.map((a: any) => ({ n: a.n, dept: a.dept, label: a.label })), stores: info.stores });
  }
  if (body.action === "report") {
    if (!REPORT_PASSWORD || body.password !== REPORT_PASSWORD) return json({ error: "wrong password" }, 401);
    return json(await rpc("question_report", { p_store: body.store || null, p_days: Math.max(1, Math.min(90, Math.round(+body.days) || 30)) }));
  }

  const store = String(body.store || "brendale").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const known = info.stores.some((s: any) => s.slug === store) ? store : "brendale";
  const engine = createEngine(db, info, known);
  const session = String(body.session || "").slice(0, 40);
  const log = (q: string, heard: string, route: string, answered: boolean, first: number, total: number) => {
    if (body.dry) return;
    inBackground(rpc("log_question", { p_store: known, p_session: session, p_question: q, p_heard: heard, p_route: route, p_answered: answered, p_first_ms: Math.round(first), p_total_ms: Math.round(total) }).catch(e => console.warn("log failed", String(e))));
  };

  let q = String(body.q || "").trim().slice(0, 300);
  const alts = Array.isArray(body.alts) ? body.alts.slice(0, 5).map((a: unknown) => String(a).slice(0, 300)) : null;
  if (alts && alts.length > 1) q = await engine.bestHeard(alts);
  if (!q) return json({ error: "empty question" }, 400);
  const asked = q;

  const r: any = await engine.route(q, { voice: !!body.voice, ctx: body.ctx || null });
  const dbMs = performance.now() - t0;
  if (!r.ai) {
    const total = performance.now() - t0;
    log(asked, q, r.route, r.ok, total, total);
    return new Response(JSON.stringify({ type: "answer", heard: q, ...r, timing: { server_ms: Math.round(total) } }) + "\n", { headers: { ...cors, "content-type": "application/x-ndjson" } });
  }

  // Everything else goes to the AI, streamed so the first words show as soon as they exist.
  const questionForAi = r.q || q;
  if (body.dry) {
    const s = r.noSearch ? { pool: [], strong: true } : r.shelf ? { pool: r.shelf, strong: true } : await engine.shelf(questionForAi, r.a, body.ctx || null, r.guess);
    return json({ type: "answer", route: "ai", dry: true, q: questionForAi, order: r.order || "", strong: s.strong, pool: s.pool, note: r.note || "", fallback: r.fallback || null, timing: { server_ms: Math.round(performance.now() - t0) } });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      let firstAt = 0, planMs = 0, shelfMs = 0, retries = 0;
      try {
        const count = await rpc("bump_usage", { p_kind: "ai" });
        if (!AI_SERVICES.length || count > AI_DAILY_CAP) throw new Error("AI cap");
        // Planning counts: if that used up the time, there's less left for the answer.
        const firstWordBy = performance.now() + AI_FIRST_WORD_MS;
        const shelfStart = performance.now();
        let tries = AI_SERVICES;
        let shelf = r.noSearch ? { pool: [], strong: true } : r.shelf ? { pool: r.shelf, strong: true } : await engine.shelf(questionForAi, r.a, body.ctx || null, r.guess);
        shelfMs = performance.now() - shelfStart;
        // Not sure which shelf this is about: let the AI decide what to search for first.
        if (!shelf.strong) {
          send({ type: "status", text: "Looking through the store..." });
          const planStart = performance.now();
          const plan = await aiPlan(AI_SERVICES, engine.planMessages(questionForAi), { tryMs: PLAN_MS });
          // DeepSeek has just shown it's in trouble, so don't spend the time left waiting on it again.
          if (plan.failed && AI_SERVICES.length > 1) tries = AI_SERVICES.slice(1);
          shelf = { ...shelf, pool: await engine.planned(plan.searches, shelf.pool) };
          planMs = performance.now() - planStart;
        }
        if (tries.length < 2) tries = [tries[0], tries[0]];
        const raw = await aiWords(tries, engine.aiMessages(questionForAi, shelf.pool, body.chat, r.order), text => {
          if (!firstAt) firstAt = performance.now() - t0;
          send({ type: "delta", text });
        }, {
          deadline: firstWordBy, tryMs: AI_TRY_MS, stallMs: AI_STALL_MS, totalMs: AI_TOTAL_MS, maxTokens: AI_MAX_TOKENS,
          onRetry: (e: unknown) => {
            retries++;
            console.warn("AI retry", String(e));
            send({ type: "status", text: "Looking through the store..." });
          },
        });
        const answer: any = engine.aiAnswer(raw, shelf.pool, questionForAi);
        if (r.note) answer.sub = r.note;
        const total = performance.now() - t0;
        send({ type: "answer", heard: q, ...answer, timing: { server_ms: Math.round(total), first_ms: Math.round(firstAt), route_ms: Math.round(dbMs), shelf_ms: Math.round(shelfMs), plan_ms: Math.round(planMs), retries, service: tries[retries].name } });
        // A question about the store has no product to show, but it was still answered.
        log(asked, q, "ai", answer.ok || !!r.noSearch, firstAt, total);
      } catch (e) {
        console.warn("AI unavailable", String(e));
        const answer: any = r.fallback || await engine.fallback(questionForAi, r.a, { voice: !!body.voice }).catch(() => ({ route: "none", say: "Sorry, I can't reach the store system right now. The team at the service desk can help.", sub: "", items: [], marks: [], ok: false }));
        if (r.note) answer.sub = `${r.note} ${answer.sub || ""}`.trim();
        const total = performance.now() - t0;
        send({ type: "answer", heard: q, ...answer, timing: { server_ms: Math.round(total), ai_failed: true, retries } });
        log(asked, q, answer.route || "none", !!answer.ok, total, total);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...cors, "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
