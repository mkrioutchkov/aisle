// Fills the report with a month of SAMPLE shopper questions, so it has something to show before real use.
// They are flagged sample = true and the report says so. Real questions from phones are never touched.
//   node scripts/seed_questions.mjs
import { sql, insert } from "./sb.mjs";

const STORES = [["brendale", 0.62], ["chermside", 0.22], ["tingalpa", 0.16]];
// question, how often, answered instantly / by AI / not at all
const QUESTIONS = [
  ["tent pegs", 90, "exact"], ["gas canister", 84, "exact"], ["head torch", 70, "exact"], ["camping chairs", 66, "exact"], ["where are the toilets", 62, "fact"],
  ["sleeping bag", 58, "exact"], ["esky", 54, "exact"], ["cheapest tent", 44, "exact"], ["fishing line", 42, "exact"], ["soft plastics", 38, "exact"],
  ["kids life jacket", 34, "exact"], ["rain jacket", 32, "exact"], ["returns", 30, "fact"], ["click and collect", 28, "fact"], ["air mattress", 26, "exact"],
  ["hiking boots", 26, "exact"], ["best camping chair under 100", 22, "exact"], ["sunscreen", 20, "exact"], ["kayak paddle", 18, "exact"], ["bike lights", 16, "exact"],
  ["what do i need for a camping weekend", 30, "ai"], ["what's a good first rod for my son", 24, "ai"], ["tent for 4 people that's easy to put up", 22, "ai"], ["what keeps drinks coldest for three days", 18, "ai"],
  ["which sleeping bag for winter in stanthorpe", 16, "ai"], ["what bait for bream", 16, "ai"], ["swag or tent for a road trip", 14, "ai"], ["how do i keep mozzies away", 14, "ai"],
  ["do you price match", 18, "ai"], ["are you open on sunday", 16, "ai"], ["what size kayak for a 6 foot bloke", 10, "ai"], ["best torch for hunting", 10, "ai"],
  // What shoppers wanted and the store couldn't answer: the part of the report a store manager reads first.
  ["fishing licence", 26, "none"], ["gas bottle refill", 24, "none"], ["tent repair service", 18, "none"], ["kayak hire", 14, "none"], ["bike servicing", 13, "none"],
  ["dog boots", 12, "none"], ["snow chains", 9, "none"], ["bear spray", 8, "none"], ["electric bike battery", 7, "none"], ["horse saddle", 4, "none"],
];
const HOURS = [0, 0, 0, 0, 0, 0, 0, 0, 2, 6, 9, 11, 12, 11, 10, 10, 9, 8, 6, 3, 1, 0, 0, 0];
const pick = (list, w) => { let r = Math.random() * list.reduce((s, x) => s + w(x), 0); for (const x of list) { r -= w(x); if (r <= 0) return x; } return list[0]; };
const now = Date.now(), DAY = 86400000, rows = [];
for (let d = 30; d >= 1; d--) {
  const date = new Date(now - d * DAY);
  // Busier at the weekend and building over the month, as word gets around.
  const volume = Math.round((date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 150 : 70) * (0.7 + 0.5 * (30 - d) / 30) * (0.85 + Math.random() * 0.3));
  let session = null, left = 0, store = null;
  for (let i = 0; i < volume; i++) {
    if (left <= 0) { session = `sample-${d}-${i}`; left = 1 + Math.floor(Math.random() * 4); store = pick(STORES, s => s[1])[0]; }
    left--;
    const [question, , route] = pick(QUESTIONS, x => x[1]);
    const hour = pick(HOURS.map((weight, h) => [h, weight]), x => x[1])[0];
    const at = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour - 10, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60)));
    const instantMs = 120 + Math.floor(Math.random() * 180), aiFirst = 800 + Math.floor(Math.random() * 700);
    rows.push({
      at: at.toISOString(), store, session, question, heard: question, route: route === "none" ? "none" : route,
      answered: route !== "none", first_ms: route === "ai" ? aiFirst : instantMs, total_ms: route === "ai" ? aiFirst + 400 : instantMs, sample: true,
    });
  }
}
await sql("delete from questions where sample");
await insert("questions", rows, 1500);
console.log(await sql("select count(*) n, min(at)::date from_day, max(at)::date to_day, count(*) filter (where not answered) unanswered from questions where sample"));
