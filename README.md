# Aisle

Find anything in store by voice or text: aisle, bay and stock in seconds.

Static site, no build step. Serve the folder and open `index.html?store=brendale`.

- `engine.js` holds the catalogue in memory and answers on the device: search, cheapest/dearest/best rated/under $X/biggest over every product, sound-alike correction for misheard words, follow-ups.
- `app.js` draws answers, handles voice, and calls the AI for open questions, passing it the few products the engine picks.
- `data/<store>.json` is built by `scripts/scrape.py` and `scripts/enrich.py` from public category pages. Products and prices are real; aisle, bay and stock numbers are sample data.
- `node scripts/test_answers.mjs` checks answers against the catalogue independently of the engine.
