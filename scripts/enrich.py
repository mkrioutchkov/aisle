"""Have the AI sort every category into the sample store layout and list the words shoppers use for it.

Writes data/taxonomy.json, which scrape.py build merges into the store data. This runs once, ahead of
time, so slang like "tinny" or "mozzie" costs nothing at question time. Existing entries are kept, so
it can be re-run after a crawl to fill in only the new categories.

    python scripts/enrich.py    (reads DEEPSEEK_API_KEY from local/.env)
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import scrape  # noqa: E402

OUT = ROOT / "data" / "taxonomy.json"
BATCH = 40
KEY = next(l.split("=", 1)[1].strip() for l in (ROOT / "local/.env").read_text().splitlines() if l.startswith("DEEPSEEK_API_KEY="))
# Words too general to help find anything; a shopper's real word for a category is specific.
GENERIC = {"gear", "stuff", "equipment", "accessory", "accessories", "outdoor", "outdoors", "product", "item", "items", "thing", "things", "kit", "set"}

LAYOUT = "\n".join(f"{a}: {label}" for a, _, label in scrape.AISLES)
SYSTEM = f"""You organise the catalogue of Anaconda, an Australian outdoor store, for an in-store shopping assistant.

For each category you are given, return:
- "aisle": the best aisle number from the layout below.
- "accessory": true if the category is add-ons or parts for something else (tent pegs, rod holders, bike tubes, boat covers), false if it's a main product people come in to buy (tents, fishing rods, bikes, boats). Clothing, footwear, lures, tackle and bait are main products.
- "aka": up to 8 lowercase words or short phrases an Australian shopper might say for this category that are NOT already in its name. Include slang and brand-like words people use generically (tinny for boats, esky for coolers, mozzie for insect repellent, sunnies for sunglasses, dunny for camping toilets) and things they'd say when they need it (beers cold for coolers, flat tyre for air compressors). Each must point to THIS category rather than most of the store, so no general words like gear, camping or outdoor.

LAYOUT
{LAYOUT}

Return only JSON: {{"categories": {{"<exact category name>": {{"aisle": 1, "accessory": false, "aka": ["..."]}}}}}}"""


def ask(cats):
    # Flash with thinking off: pro's thinking ate the token limit and cut the JSON short on most batches.
    body = {"model": "deepseek-flash", "thinking": {"type": "disabled"}, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "\n".join(cats)}],
            "response_format": {"type": "json_object"}, "max_tokens": 8000}
    req = urllib.request.Request("https://api.deepseek.com/chat/completions", json.dumps(body).encode(),
                                 {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(json.load(resp)["choices"][0]["message"]["content"])["categories"]


def clean(entry):
    aka = []
    for term in entry.get("aka", []):
        term = re.sub(r"\s+", " ", str(term).lower()).strip()
        if term and term not in GENERIC and term not in aka:
            aka.append(term)
    return {"aisle": int(entry["aisle"]), "accessory": bool(entry.get("accessory")), "aka": aka[:8]}


def main():
    taxonomy = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    cats = sorted({p["cat"] for p in scrape.assigned_products()} - set(taxonomy))
    print("categories to do:", len(cats), flush=True)
    valid = {a for a, _, _ in scrape.AISLES}
    for i in range(0, len(cats), BATCH):
        chunk = cats[i:i + BATCH]
        for attempt in range(3):
            try:
                got = ask(chunk)
                break
            except Exception as e:
                print("  retry", repr(e)[:120], flush=True)
                time.sleep(3)
        else:
            continue
        for c in chunk:
            if c in got:
                entry = clean(got[c])
                if entry["aisle"] in valid:
                    taxonomy[c] = entry
        OUT.write_text(json.dumps(taxonomy, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8")
        print(f"  {min(i + BATCH, len(cats))}/{len(cats)} done, {len(taxonomy)} in taxonomy", flush=True)
    print("missing:", sorted(set(cats) - set(taxonomy))[:20])


if __name__ == "__main__":
    main()
