# Architecture

A shopper scans a QR code in store, asks by voice or text, and gets the aisle, bay, stock and a map. This document says how it works, how fast it has been measured, and what changes to run it for real.

Nothing here is a mock-up of the architecture. The page, server, database and AI are the real path a question takes. The data is the only thing that's stand-in, and it sits behind tables that real feeds would fill.

## How a question is answered

```mermaid
flowchart LR
  P["Phone<br/>static page, no catalogue, no keys"] -->|question| F["Server function<br/>routes the question"]
  F -->|one SQL query| D[("Postgres<br/>products, stock, shelves,<br/>question log")]
  F -->|"question + the few<br/>products that fit"| A["AI model"]
  A -->|words as they're written| F
  F -->|answer as it streams| P
```

1. **The page holds nothing.** It sends the question, plus a short memory of the last answer so follow-ups like "got anything cheaper?" work. The server keeps nothing per shopper, so any server instance can answer any question.
2. **The server decides who answers.** The AI answers by default. The database answers directly only where there's one right answer and the AI can't beat it: an exact product word ("tent pegs"), a ranking ("cheapest fishing rod", "best tent under $200"), a store fact, a shopping list or a starter kit.
3. **Rankings are computed, never guessed.** "Cheapest" is an SQL sort over every product in stock at that store, not a model's opinion.
4. **The AI only sees what's on the shelf.** Search picks at most 18 products, with live price, aisle, bay and stock, and the AI recommends from those. It can't quote a product or price the store doesn't have. If search can't tell which shelf a question is about, the AI first says what to search for, then answers from the results.
5. **Voice mistakes are handled in two steps.** A misheard phrase is corrected directly only when the result is something the store really calls a product ("tint pegs" to "tent pegs"). Anything less certain goes to the AI as heard, so "snow chains" doesn't turn into "snow chinos".
6. **Every question is logged**, with no personal details, for the store's report: what people ask, what couldn't be answered, and when.

## Measured

From a home connection in Brisbane to the server in Sydney, on the free hosting plan, with the full 11,898 product catalogue. A phone on 4G adds its own network time.

**The number to expect.** In a store, questions come minutes apart, and by then the way to the answer has gone cold: the connections to the host, the server's worker, its connection to the database. So when a shopper touches the screen after a quiet spell, the page sends a small request ahead of the question to wake all of that up. This compares the two over two hours, with each question asked both ways, a couple of minutes apart. Re-run with `node scripts/soak.mjs 2 150 3 warm`.

| | Not woken first | After touching the screen |
|---|---|---|
| Direct answer, median | 0.47 s | 0.25 s |
| Direct answer, slowest | 0.81 s | 1.89 s |
| AI, first words, median | 1.23 s | 1.10 s |
| AI, first words, slowest | 1.54 s | 1.49 s |
| AI, finished, median | 1.64 s | 1.49 s |
| AI, finished, slowest | 1.95 s | 1.90 s |

16 direct answers and about 8 AI answers each way. The only two direct answers over a second, 1.5 s and 1.9 s, landed in the host's slow seconds described under Known limits. A shopper can take their time: asking 1, 5, 10 or 15 seconds after touching the screen took 0.23, 0.23, 0.25 and 0.27 s, against 0.53 s with no warning (six of each).

**Best case.** Questions asked straight after one another, with everything already awake. This is about what a shopper gets on a follow-up question, not on their first. Re-run with `node scripts/latency.mjs`.

<!-- latency:start -->
| Kind of question | Answered by | Asked | First words, median | First words, 95th | Finished, median | Slowest | Failed |
|---|---|---|---|---|---|---|---|
| Store fact | fact | 6 | 0.12 s | 0.69 s | 0.12 s | 0.69 s | 0 |
| Exact product word | exact | 16 | 0.20 s | 0.68 s | 0.20 s | 0.68 s | 0 |
| Ranking over the whole catalogue | exact | 12 | 0.14 s | 0.52 s | 0.14 s | 0.52 s | 0 |
| Several things at once | list | 6 | 0.22 s | 0.41 s | 0.22 s | 0.41 s | 0 |
| Starter kit | kit | 4 | 0.31 s | 0.32 s | 0.31 s | 0.32 s | 0 |
| AI, knows the shelf | ai | 16 | 0.84 s | 1.46 s | 1.23 s | 1.77 s | 0 |
| AI, plans its own search first | ai | 8 | 1.02 s | 2.36 s | 1.32 s | 2.87 s | 0 |

Several shoppers at the same moment, everything except the AI call:

| At once | Median | 95th | Slowest | Failed |
|---|---|---|---|---|
| 5 | 0.33 s | 0.53 s | 0.53 s | 0 |
| 10 | 0.40 s | 0.50 s | 0.50 s | 0 |
| 25 | 0.87 s | 1.28 s | 1.31 s | 0 |
| 50 | 1.54 s | 2.32 s | 2.57 s | 0 |

8 real AI questions at once: first words median 1.85 s, slowest first words 2.44 s, slowest finished 2.96 s, 0 failed.
<!-- latency:end -->

Answers are checked by `node scripts/test_answers.mjs`: over 440 checks against the deployed server, with the expected results worked out from the raw data independently of the server's logic.

## What's real, what's stand-in, what changes

| Part | Today | For a real rollout | Size of the change |
|---|---|---|---|
| Products, prices, ratings | Real, from public category pages | Product feed | Fill the same tables |
| Aisle and bay | Sample | Planogram or location data | Fill the same column. **This data has to exist, and it's the first thing to check** |
| Stock | Sample, changes every 5 minutes to prove the path | Inventory feed, per store | Fill the same column |
| Store layouts | Sample map | One real layout per store | Data, plus a map per store |
| Stores | 3, selected by the QR link | All of them | New rows |
| AI model | DeepSeek, picked for speed and cost | A model hosted in Australia that meets the retailer's data rules | One function |
| Server and database | Supabase free plan, Sydney | Paid plan, or the same Postgres and server code in the retailer's cloud | Hosting, not code |
| Web page | GitHub Pages | The retailer's domain | Same files |
| Report access | One shared password | Staff sign-in | Small |
| Abuse limits | Per-device-address rate limit, daily AI cap | Same, tuned on real traffic | Settings |

## Known limits

- **Free hosting** pauses after a week without use, and gets slower past roughly 25 questions in the same instant. Its gateway also turned requests away for about a second once, during a burst of 50 at the same moment. The page retries on its own, so a shopper would just wait a second longer. Fine for one store; a chain needs the paid plan.
- **Slow seconds on the shared host.** For a few seconds after each 5-minute mark on the clock, and again about 12 seconds after it, a question can wait 1 to 3 s longer. That's about 3% of the time. Just after other minutes the extra is about 0.5 s. The wait comes before the server's code runs: the code's own time stays around 0.1 to 0.3 s, and moving our own 5-minute job away from those moments changed nothing. It needs measuring again on the paid plan.
- **Nothing stays warm on the host for long.** It replaces the server's worker about every 75 seconds, however busy it is. So a new worker starts from a copy of the word list and store layout built into the function, the server pings itself every 40 seconds, and the page wakes things up when a shopper touches the screen.
- **The AI model** occasionally takes several seconds to start: about 1 question in 40 took over 3 s, 4.7 s at worst. The page says what it's doing while it waits, and if the first word takes more than 6 s the server answers without the AI.
- **Voice** uses the speech recognition built into the phone's browser. It varies by device and accent, and is worse in a noisy store. It has been used on one real iPhone so far, which heard "fishing rod" as "facing road"; that's now corrected. Typing always works.
- **AI wording** can still oversell a product a little. It's limited to the products it's given, and it's told not to claim features the product name doesn't show, but this is a rule, not a guarantee.
- **The sample report** on `report.html` is generated data, and says so on the page. Its "Just asked" list and speed figure come only from real questions.

## Where things are

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css`, `config.js` | The shopper's page |
| `report.html`, `report.js`, `report.css` | The store's report |
| `supabase/functions/api/index.ts` | The endpoint: rate limits, AI streaming, logging |
| `supabase/functions/api/engine.mjs` | Routing, search, voice correction, what the AI gets told |
| `supabase/functions/api/text.mjs` | Shared word rules, also used when loading data |
| `supabase/functions/api/snapshot.mjs` | Word list and store layout built into the function, so a new worker doesn't have to fetch them. Generated by `scripts/make_snapshot.mjs` |
| `supabase/migrations/` | Tables, search functions, report, scheduled jobs |
| `scripts/seed.mjs` | Loads the catalogue, stock and search words |
| `scripts/test_answers.mjs` | Answer checks |
| `scripts/latency.mjs`, `scripts/soak.mjs` | Latency with questions in quick succession, and spaced out over hours |
| `print/make_qr.py` | The store sign and a QR label per aisle |
