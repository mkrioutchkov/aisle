// How the answer stream copes when an AI service misbehaves, and what it sends to each service, against fake services on
// this PC. Makes no AI calls. The limits are a tenth of the real ones so it runs quickly.
//   node scripts/test_stream.mjs
import { createServer } from "node:http";
import { aiPlan, aiWords, anthropic, deepseek } from "../supabase/functions/api/stream.mjs";

const LIMITS = { tryMs: 350, stallMs: 200, totalMs: 1200, maxTokens: 200 };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const isClaude = req => req.url.includes("anthropic");
const event = (req, text) => {
  if (text === ":") return ": keep-alive\n\n";
  if (isClaude(req)) return `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
};

let script = [], seen = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
  const step = script.shift() || { status: 500 };
  if (step.status) {
    res.writeHead(step.status);
    res.end();
    return;
  }
  if (step.reply !== undefined) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(isClaude(req) ? { content: [{ type: "text", text: step.reply }] } : { choices: [{ message: { content: step.reply } }] }));
    return;
  }
  if (step.never) return;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  if (isClaude(req)) res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message"}}\n\nevent: ping\ndata: {"type":"ping"}\n\n');
  for (const [text, wait] of step.pieces || []) {
    if (wait) await sleep(wait);
    if (res.destroyed) return;
    res.write(event(req, text));
  }
  for (const chunk of step.chunks || []) {
    await sleep(5);
    res.write(chunk);
  }
  if (step.error) res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: step.error, message: "Overloaded" } })}\n\n`);
  if (step.hang) return;
  res.end(isClaude(req) ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : "data: [DONE]\n\n");
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const DS = deepseek({ key: "ds-key", model: "ds-model", url: `${base}/deepseek` });
const CL = anthropic({ key: "cl-key", model: "cl-model", url: `${base}/anthropic` });
const MESSAGES = [{ role: "system", content: "Be brief." }, { role: "user", content: "tents?" }, { role: "assistant", content: "Aisle 1. [[1]]" }, { role: "user", content: "cheaper?" }];

const healthy = { pieces: [["The", 0], [" tent", 5], [" is", 5], [" in", 5], [" Aisle 1.", 5], [" [[1]]", 5]] };
const SAID = "The tent is in Aisle 1. ";
let passed = 0, failed = 0;
const report = (name, problem, detail, ms, requests) => {
  if (problem) {
    failed++;
    console.log(`FAIL ${name}: ${problem}\n     ${JSON.stringify(detail)}`);
  } else {
    passed++;
    console.log(`ok   ${name} (${Math.round(ms)} ms, ${requests} request${requests > 1 ? "s" : ""})`);
  }
};
async function check(name, steps, want, { tries = [DS, DS], ...limits } = {}) {
  script = steps.map(s => ({ ...s }));
  seen = [];
  const shown = [];
  let retries = 0, raw = null, error = null;
  const t0 = performance.now();
  try {
    raw = await aiWords(tries, MESSAGES, text => shown.push({ text, at: performance.now() - t0 }), { ...LIMITS, deadline: t0 + 700, onRetry: () => retries++, ...limits });
  } catch (e) {
    error = e;
  }
  const r = { raw, error, requests: seen.length, retries, ms: performance.now() - t0, words: shown.map(s => s.text).join(""), first: shown[0], seen };
  report(name, want(r), { raw, error: error && String(error), requests: seen.length, retries, ms: Math.round(r.ms), words: r.words }, r.ms, seen.length);
}
async function checkPlan(name, services, steps, want, tryMs = [150, 150]) {
  script = steps.map(s => ({ ...s }));
  seen = [];
  const warn = console.warn;
  console.warn = () => {};
  const t0 = performance.now(), plan = await aiPlan(services, MESSAGES, { tryMs });
  console.warn = warn;
  const ms = performance.now() - t0;
  report(name, want(plan, ms), { plan, requests: seen.length, ms: Math.round(ms) }, ms, seen.length);
}
const worked = r => (r.error ? "it gave up" : r.words !== SAID ? "wrong words shown" : "");
const gaveUp = r => (!r.error ? "it should have given up" : "");
const backupAnswered = r => worked(r) || (r.retries !== 1 ? "no second try" : r.seen[1]?.path !== "/anthropic" ? "second try wasn't the backup" : "");

// One service, asked twice: how it runs with no backup key.
await check("a healthy answer comes through, without its tag", [healthy], r => worked(r) || (r.requests !== 1 ? "asked twice" : ""));
await check("the first word waits for the second", [{ pieces: [["The", 0], [" tent", 100], [" is in Aisle 1. [[1]]", 5]] }], r => (r.first?.text !== "The tent" ? `first showed "${r.first?.text}"` : r.first.at < 90 ? "showed too early" : ""));
await check("a one-piece answer still shows", [{ pieces: [["Sorry, no. [[]]", 0]] }], r => (r.words !== "Sorry, no. " ? "wrong words shown" : ""));
await check("a one-piece answer with no tag still shows", [{ pieces: [["Sorry, no.", 0]] }], r => (r.words !== "Sorry, no." ? "wrong words shown" : ""));
await check("pieces split across network chunks join up", [{ chunks: ['data: {"choices":[{"delta":{"content":"The tent', ' is in Aisle 1. "}}]}\n', '\ndata: {"choices":[{"delta":{"content":"[[1]]"}}]}\n\n'] }], r => worked(r));
await check("a stall after the first word is dropped and retried, unseen", [{ pieces: [["Down", 0]], hang: true }, healthy], r => worked(r) || (r.retries !== 1 ? "no retry" : r.ms < 190 ? "retried too soon" : r.ms > 330 ? "took too long" : ""));
await check("two stalls in a row give up, with nothing shown", [{ pieces: [["Down", 0]], hang: true }, { pieces: [["Our", 0]], hang: true }], r => gaveUp(r) || (r.words ? "showed words" : r.requests !== 2 ? "wrong number of tries" : r.ms > 480 ? "took too long" : ""));
await check("a refusal is retried", [{ status: 503 }, healthy], r => worked(r) || (r.retries !== 1 ? "no retry" : ""));
await check("two refusals give up quickly", [{ status: 503 }, { status: 503 }], r => gaveUp(r) || (r.requests !== 2 ? "wrong number of tries" : r.ms > 100 ? "took too long" : ""));
await check("no first word: cut off and retried", [{ hang: true }, healthy], r => worked(r) || (r.ms < 340 ? "cut off too soon" : r.ms > 480 ? "took too long" : ""));
await check("no first word twice: gives up by the deadline", [{ hang: true }, { hang: true }], r => gaveUp(r) || (r.requests !== 2 ? "wrong number of tries" : r.ms < 680 || r.ms > 780 ? "missed the deadline" : ""));
await check("a stall with words on screen isn't retried", [{ pieces: [["The", 0], [" tent", 5], [" is", 5]], hang: true }], r => gaveUp(r) || (r.requests !== 1 ? "started the sentence over" : r.words !== "The tent is" ? "wrong words shown" : ""));
await check("slow but moving is left alone", [{ pieces: [["The", 0], [" tent", 150], [" is", 150], [" in", 150], [" Aisle 1.", 150], [" [[1]]", 150]] }], r => worked(r) || (r.retries ? "retried a healthy answer" : ""));
await check("keep-alive comments don't count as words", [{ pieces: [["Down", 0], [":", 50], [":", 50], [":", 50], [":", 50], [":", 50], [":", 50]], hang: true }, healthy], r => worked(r) || (r.retries !== 1 ? "no retry" : ""));
await check("words that never finish hit the total limit", [{ pieces: Array.from({ length: 40 }, (_, i) => [`${i} `, 100]), hang: true }], r => gaveUp(r) || (r.ms < 1150 || r.ms > 1500 ? "missed the total limit" : r.requests !== 1 ? "started over" : ""));
await check("time used up by planning leaves one short try", [{ hang: true }], r => gaveUp(r) || (r.requests !== 1 ? "tried again" : r.ms > 180 ? "took too long" : ""), { deadline: performance.now() + 100 });
await check("no retry when too little time is left", [{ pieces: [["Down", 0]], hang: true }, healthy], r => gaveUp(r) || (r.requests !== 1 ? "tried again" : ""), { deadline: performance.now() + 150 });
await check("an empty answer is retried", [{}, healthy], r => worked(r) || (r.retries !== 1 ? "no retry" : ""));
await check("two empty answers give up", [{}, {}], r => gaveUp(r));

// With a backup: the second try goes to Anthropic.
const both = { tries: [DS, CL] };
await check("Anthropic's stream format reads the same", [healthy], r => worked(r), { tries: [CL] });
await check("a stall goes to the backup, unseen", [{ pieces: [["Down", 0]], hang: true }, healthy], backupAnswered, both);
await check("a refusal goes to the backup", [{ status: 503 }, healthy], backupAnswered, both);
await check("no first word goes to the backup", [{ hang: true }, healthy], backupAnswered, both);
await check("a healthy first service never touches the backup", [healthy], r => worked(r) || (r.requests !== 1 ? "asked the backup too" : ""), both);
await check("both failing gives up", [{ status: 503 }, { status: 529 }], r => gaveUp(r) || (r.requests !== 2 ? "wrong number of tries" : ""), both);
await check("an error in Anthropic's stream gives up at once", [{ pieces: [["The", 0]], error: "overloaded_error", hang: true }], r => gaveUp(r) || (!/overloaded_error/.test(String(r.error)) ? "wrong error" : r.words ? "showed words" : r.ms > 150 ? "waited for the stall limit" : ""), { tries: [CL] });

// What each service is sent.
await check("what's sent to Anthropic", [healthy], ({ seen: [s] }) => {
  const b = s.body, h = s.headers;
  if (h["x-api-key"] !== "cl-key" || h.authorization) return "wrong key header";
  if (h["anthropic-version"] !== "2026-10-21") return "wrong version";
  if (b.model !== "cl-model" || b.max_tokens !== 200 || b.stream !== true) return "wrong settings";
  if (b.thinking?.type !== "disabled") return "thinking left on";
  if (b.system !== "Be brief.") return "system prompt not moved";
  if (b.messages.length !== 3 || b.messages.some(m => m.role === "system") || b.messages[0].role !== "user") return "wrong messages";
  if (["temperature", "top_p", "top_k", "response_format"].some(k => k in b)) return "sent something this API version refuses";
  return "";
}, { tries: [CL] });
await check("what's sent to DeepSeek", [healthy], ({ seen: [s] }) => {
  const b = s.body;
  if (s.headers.authorization !== "Bearer ds-key" || s.headers["x-api-key"]) return "wrong key header";
  if (b.model !== "ds-model" || b.max_tokens !== 200 || b.stream !== true || b.thinking?.type !== "disabled") return "wrong settings";
  if (b.messages.length !== 4 || b.messages[0].role !== "system" || "system" in b) return "wrong messages";
  return "";
});

// Planning a search.
const PLAN = '{"searches":[{"q":"surf rod","sort":"rating","max":null}]}';
const planned = p => (p.searches[0]?.q !== "surf rod" ? "lost the searches" : "");
await checkPlan("a plan from the first service", [DS, CL], [{ reply: PLAN }], p => planned(p) || (p.failed !== 0 ? "counted a failure" : seen.length !== 1 ? "asked the backup too" : seen[0].body.response_format?.type !== "json_object" ? "not asked for JSON" : ""));
await checkPlan("a slow first service goes to the backup", [DS, CL], [{ never: true }, { reply: PLAN }], (p, ms) => planned(p) || (p.failed !== 1 ? "should count one failure" : ms < 140 ? "didn't wait" : ""));
await checkPlan("a refusal goes to the backup", [DS, CL], [{ status: 503 }, { reply: PLAN }], p => planned(p) || (p.failed !== 1 ? "should count one failure" : ""));
await checkPlan("a reply in a code fence still reads", [CL], [{ reply: "```json\n" + PLAN + "\n```" }], p => planned(p));
await checkPlan("nonsense goes to the next service", [DS, CL], [{ reply: "no idea" }, { reply: PLAN }], p => planned(p) || (p.failed !== 1 ? "should count one failure" : ""));
await checkPlan("nothing replying just means no plan", [DS, CL], [{ status: 503 }, { status: 529 }], p => (p.searches.length || p.failed !== 2 ? "should be an empty plan" : ""));
await checkPlan("with no backup, one slow try and no plan", [DS], [{ never: true }], (p, ms) => (p.searches.length || p.failed !== 1 ? "should be an empty plan" : seen.length !== 1 ? "tried twice" : ms < 340 ? "didn't wait" : ""), [350]);

server.closeAllConnections();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
