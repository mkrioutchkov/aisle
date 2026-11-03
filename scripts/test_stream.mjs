// How the answer stream copes when the AI service misbehaves, against a fake service on this PC. Makes no AI calls.
// The limits are a tenth of the real ones so it runs quickly.
//   node scripts/test_stream.mjs
import { createServer } from "node:http";
import { aiWords } from "../supabase/functions/api/stream.mjs";

const LIMITS = { tryMs: 350, stallMs: 200, totalMs: 1200, tries: 2 };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const event = text => (text === ":" ? ": keep-alive\n\n" : `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);

let script = [], requests = 0;
const server = createServer(async (req, res) => {
  req.resume();
  requests++;
  const step = script.shift() || { status: 500 };
  if (step.status) {
    res.writeHead(step.status);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
  for (const [text, wait] of step.pieces || []) {
    if (wait) await sleep(wait);
    if (res.destroyed) return;
    res.write(event(text));
  }
  for (const chunk of step.chunks || []) {
    await sleep(5);
    res.write(chunk);
  }
  if (step.hang) return;
  res.end("data: [DONE]\n\n");
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/`;

const healthy = { pieces: [["The", 0], [" tent", 5], [" is", 5], [" in", 5], [" Aisle 1.", 5], [" [[1]]", 5]] };
const SAID = "The tent is in Aisle 1. ";
let passed = 0, failed = 0;
async function check(name, steps, want, limits = {}) {
  script = steps.map(s => ({ ...s }));
  requests = 0;
  const shown = [];
  let retries = 0, raw = null, error = null;
  const t0 = performance.now();
  try {
    raw = await aiWords(signal => fetch(url, { method: "POST", signal }), text => shown.push({ text, at: performance.now() - t0 }), { ...LIMITS, deadline: t0 + 700, onRetry: () => retries++, ...limits });
  } catch (e) {
    error = e;
  }
  const r = { raw, error, requests, retries, ms: performance.now() - t0, words: shown.map(s => s.text).join(""), first: shown[0] };
  const problem = want(r);
  if (problem) {
    failed++;
    console.log(`FAIL ${name}: ${problem}\n     ${JSON.stringify({ raw, error: error && String(error), requests, retries, ms: Math.round(r.ms), words: r.words })}`);
  } else {
    passed++;
    console.log(`ok   ${name} (${Math.round(r.ms)} ms, ${requests} request${requests > 1 ? "s" : ""})`);
  }
}
const worked = r => (r.error ? "it gave up" : r.words !== SAID ? "wrong words shown" : "");
const gaveUp = r => (!r.error ? "it should have given up" : "");

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

server.closeAllConnections();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
