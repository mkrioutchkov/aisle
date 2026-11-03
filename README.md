# Aisle

Find anything in store by voice or text: aisle, bay and stock in seconds.

Scan the store's QR code, ask, and get the answer on your phone. The page is static and holds no catalogue and no keys: questions go to a server function in Sydney, which answers from Postgres and an AI model and streams the answer back. See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works, how fast it's been measured, and what's sample data.

- **Shoppers:** `index.html?store=brendale`, optionally `&at=<aisle>` so the map starts from where the shopper is standing.
- **The store:** `report.html` shows what people ask and what they couldn't find. It needs the report password.

To run the page locally, serve the folder and open `index.html?store=brendale`. The page talks to the deployed server set in `config.js`.

| Command | What it does |
|---|---|
| `node scripts/seed.mjs` | Loads the catalogue, stock and search words into the database |
| `node scripts/seed_questions.mjs` | Fills the report with a month of sample questions, flagged as sample |
| `node scripts/test_answers.mjs` | Checks answers from the deployed server against the data, independently of the server's logic |
| `node scripts/test_names.mjs [products]` | Asks for random products by name: whole, misheard and in part. Counts how often the product is found |
| `node scripts/test_stream.mjs` | Checks how the answer stream copes when the AI service stalls or refuses. Uses a fake service, so no AI calls |
| `node scripts/latency.mjs` | Measures what a shopper waits for with questions in quick succession, which is the best case |
| `node scripts/soak.mjs [hours] [seconds between questions] [AI on every Nth] [warm]` | Asks questions spaced out, which is the number to expect. With `warm`, asks each one both with and without the page's warm-up |
| `node scripts/make_snapshot.mjs` | Rebuilds the word list and store layout built into the server function. Run it when the catalogue or layout changes, then deploy |
| `python print/make_qr.py` | Makes the store sign and a QR label per aisle |

`data/<store>.json` is built by `scripts/scrape.py` and `scripts/enrich.py` from public category pages. Products and prices are real; aisle, bay and stock numbers are sample data. The scripts read their secrets from `local/.env`, which git ignores.
