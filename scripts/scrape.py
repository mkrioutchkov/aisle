"""Build data/<store>.json from the public anacondastores.com category pages.

    python scripts/scrape.py crawl    fetch every category in the site's navigation (resumable)
    python scripts/scrape.py deep     page further into each category (resumable)
    python scripts/enrich.py          place each category in an aisle, list shoppers' words for it
    python scripts/scrape.py build    write data/<store>.json and data/<store>-img.json

Products (name, brand, category, price, image, link) are real. Aisle, bay and stock are
SAMPLE values, so the demo looks plausible without pretending to be real store data. Only
/en-au/c/<slug> pages are fetched (allowed by robots.txt), with a pause between requests.
"""
import hashlib
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://www.anacondastores.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data"
CACHE = ROOT / "local" / "scrape-cache.json"
SKIP = re.compile(r"deals|collections|gift|clearance|^sale|hot-?buys|catalogue")
# Extra pages for categories people ask about most, and the ones the printed sign's example
# questions depend on (tent pegs, kids sleeping bag, gas canister). Default is 1 page of 18 tiles.
PAGES = {
    "tent-accessories": 3, "sleeping-bags": 3, "camping-fuel-fire": 2, "camping-tents": 2, "family-tents": 2, "swags": 2,
    "camping-chairs": 2, "coolers": 2, "headlamps": 2, "lanterns": 2, "spinning-combos": 2, "kids-combos": 2, "hiking-packs": 2,
    "kayaks": 2, "rain-jackets-coats": 2, "hiking-boots-shoes": 2,
}

# Sample store layout: aisle, department, label
AISLES = [
    (1, "Camping", "Tents & swags"), (2, "Camping", "Sleeping"), (3, "Camping", "Camp furniture"), (4, "Camping", "Camp kitchen"),
    (5, "Camping", "Coolers & fridges"), (6, "Camping", "Lighting & power"), (7, "Camping", "Camp essentials"),
    (8, "Hiking", "Packs & navigation"),
    (9, "Fishing", "Rods"), (10, "Fishing", "Reels & combos"), (11, "Fishing", "Tackle & lures"), (12, "Fishing", "Bait & crabbing"),
    (13, "Water", "Boats & marine"), (14, "Water", "Kayaks & paddle"), (15, "Water", "Swim & snorkel"), (16, "Water", "Beach"),
    (17, "4WD", "4WD & auto"), (18, "Caravan", "Caravan"),
    (19, "Cycling", "Bikes & scooters"), (20, "Travel", "Tech & travel"),
    (21, "Apparel", "Men's clothing"), (22, "Apparel", "Women's clothing"), (23, "Apparel", "Kids' clothing & footwear"), (24, "Apparel", "Footwear & socks"),
]
FACILITIES = [
    {"keys": ["toilet", "toilets", "bathroom", "restroom", "loo", "dunny"], "answer": "Toilets are at the back of the store, behind Aisle 9."},
    {"keys": ["service desk", "returns", "refund", "exchange", "help desk", "customer service"], "answer": "The service desk is at the front, right of the entrance. Returns and exchanges are done there."},
    {"keys": ["click and collect", "click & collect", "collect", "pick up", "pickup", "online order"], "answer": "Click & Collect orders are picked up at the service desk, front right."},
    {"keys": ["fitting room", "change room", "changing room", "try on"], "answer": "Fitting rooms are next to Aisle 21, in clothing."},
    {"keys": ["checkout", "check out", "tills", "register"], "answer": "Checkouts are at the front of the store, by the entrance."},
    {"keys": ["trolley", "trolleys", "basket", "baskets"], "answer": "Trolleys and baskets are just inside the entrance."},
]
PRICE_PATTERNS = (
    r'itemprop="price"[^>]*content="([\d.]+)"',
    r'(?:\$|&#36;)\s*(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)',
)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-AU,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def nav_slugs():
    return sorted(s for s in set(re.findall(r"/en-au/c/([a-z0-9-]+)", get(f"{BASE}/en-au"))) if not SKIP.search(s))


def tiles(page):
    for chunk in page.split('data-gtm-product-code="')[1:]:
        attrs = {k: html.unescape(v).strip() for k, v in re.findall(r'data-product-([\w-]+)="([^"]*)"', chunk)}
        pid = attrs.get("id") or chunk.split('"', 1)[0]
        url = attrs.get("url", "")
        name = attrs.get("name", "")
        if not name:
            m = re.search(r'<img[^>]+alt="([^"]+)"', chunk)
            name = html.unescape(m.group(1)).strip() if m else ""
        if not name and "/p/" in url:
            name = url.split("/p/")[1].split("/")[0].replace("-", " ").title()
        price = None
        for pat in PRICE_PATTERNS:
            m = re.search(pat, chunk)
            if m:
                price = float(m.group(1).replace(",", "")) or None
                break
        if not (pid and name and url):
            continue
        reviews = attrs.get("reviews") or ""
        yield {
            "id": pid, "name": re.sub(r"\s+", " ", name), "brand": attrs.get("brand", "").replace("-", " ").title(),
            "cat": attrs.get("list", ""), "price": price,
            "rating": round(float(attrs.get("ratingAvg") or 0), 1) or None,
            "reviews": int(reviews) if reviews.isdigit() else 0,
            "url": url, "img": attrs.get("hero-image-url", ""),
        }


def crawl():
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    slugs = nav_slugs()
    print("categories", len(slugs), "already done", sum(s in cache for s in slugs), flush=True)
    for n, slug in enumerate(slugs, 1):
        if slug in cache:
            continue
        items, ok = [], True
        for q in [""] + [f"?q=%3Arelevance&page={k}" for k in range(1, PAGES.get(slug, 1))]:
            try:
                items += list(tiles(get(f"{BASE}/en-au/c/{slug}{q}")))
            except Exception as e:
                print("  skip", slug, q, repr(e)[:80], flush=True)
                ok = False
            time.sleep(0.4)
        if ok:
            cache[slug] = items
        if n % 25 == 0:
            CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            print(f"  {n}/{len(slugs)} categories, {len({t['id'] for v in cache.values() for t in v})} products", flush=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    print("done", len(cache), "categories,", len({t["id"] for v in cache.values() for t in v}), "products", flush=True)


def deep(max_pages=30, budget=3000):
    """Page further into each category, narrowest first, until a page adds almost nothing new.
    Broad pages like Clothing then stop quickly because their children already gave up those products."""
    cache = json.loads(CACHE.read_text(encoding="utf-8"))
    seen_in = {}
    for slug, items in cache.items():
        for t in items:
            seen_in.setdefault(t["id"], set()).add(slug)
    breadth = {slug: len({o for t in items for o in seen_in[t["id"]]}) for slug, items in cache.items()}
    known, fetched = set(seen_in), 0
    for n, slug in enumerate(sorted(cache, key=lambda s: breadth[s]), 1):
        page = max(PAGES.get(slug, 1), len(cache[slug]) // 18)
        if len(cache[slug]) % 18:
            continue  # the last page we saw wasn't full, so this category has no more
        while page < max_pages and fetched < budget:
            try:
                items = list(tiles(get(f"{BASE}/en-au/c/{slug}?q=%3Arelevance&page={page}")))
            except Exception as e:
                print("  stop", slug, page, repr(e)[:80], flush=True)
                break
            fetched += 1
            time.sleep(0.4)
            mine = {t["id"] for t in cache[slug]}
            fresh = [t for t in items if t["id"] not in mine]
            cache[slug] += fresh
            added = len({t["id"] for t in fresh} - known)
            known |= {t["id"] for t in fresh}
            page += 1
            if len(items) < 18 or added < 2:
                break
        if n % 25 == 0:
            CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            print(f"  {n}/{len(cache)} categories, {fetched} pages, {len(known)} products", flush=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    print("deep done:", fetched, "pages,", len(known), "products", flush=True)


def assigned_products():
    """Each product once, under its most specific category: a broad page like Clothing shares its
    products with many other categories, a leaf like Camping Chairs with few."""
    cache = json.loads(CACHE.read_text(encoding="utf-8"))
    seen_in = {}
    for slug, items in cache.items():
        for t in items:
            seen_in.setdefault(t["id"], set()).add(slug)
    breadth = {slug: len({o for t in items for o in seen_in[t["id"]]}) for slug, items in cache.items()}
    best = {}
    for slug, items in cache.items():
        for t in items:
            if t["price"] is None:
                continue
            rank = (breadth[slug], -len(slug))
            if t["id"] not in best or rank < best[t["id"]][0]:
                best[t["id"]] = (rank, {**t, "cat": t["cat"] or slug.replace("-", " ").title()})
    return [v[1] for v in best.values()]


def sample_stock(pid):
    h = int(hashlib.sha1(pid.encode()).hexdigest()[:8], 16)
    return 0 if h % 13 == 0 else 1 + h % 24


def build(store="brendale", name="Brendale"):
    taxonomy = json.loads((OUT / "taxonomy.json").read_text(encoding="utf-8"))
    products = assigned_products()
    missing = sorted({p["cat"] for p in products} - set(taxonomy))
    if missing:
        sys.exit(f"not in taxonomy.json, run enrich.py: {missing[:20]}")
    aisles, imgs, out = [], {}, []
    for aisle, dept, label in AISLES:
        items = sorted((p for p in products if taxonomy[p["cat"]]["aisle"] == aisle), key=lambda p: (p["cat"], p["name"]))
        for i, p in enumerate(items):
            imgs[p["id"]] = p["img"].replace(f"{BASE}/medias/", "")
            out.append({
                "id": p["id"], "name": p["name"], "brand": p["brand"], "cat": p["cat"], "price": p["price"], "rating": p["rating"],
                "reviews": p["reviews"], "url": p["url"].replace(f"{BASE}/en-au/p/", ""),
                "dept": dept, "aisle": aisle, "bay": 1 + i * 12 // max(1, len(items)), "stock": sample_stock(p["id"]),
            })
        cats = {}
        for p in items:
            cats[p["cat"]] = cats.get(p["cat"], 0) + 1
        aisles.append({"n": aisle, "dept": dept, "label": label, "cats": sorted(cats, key=lambda c: -cats[c])})
        print(f"aisle {aisle:2} {label:26} {len(items):4} products, {len(cats):3} categories")
    aka = {c: v["aka"] for c, v in taxonomy.items() if v.get("aka")}
    accessories = sorted(c for c, v in taxonomy.items() if v.get("accessory"))
    data = {"store": name, "slug": store, "sample": True, "source": "anacondastores.com public category pages",
            "generated": time.strftime("%Y-%m-%d"), "aisles": aisles, "facilities": FACILITIES, "aka": aka, "accessories": accessories, "products": out}
    main_file, img_file = OUT / f"{store}.json", OUT / f"{store}-img.json"
    main_file.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    img_file.write_text(json.dumps(imgs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("products", len(out), "| main", main_file.stat().st_size, "bytes | images", img_file.stat().st_size, "bytes")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "crawl":
        crawl()
    elif cmd == "deep":
        deep()
    elif cmd == "build":
        build(*sys.argv[2:4])
    else:
        sys.exit(__doc__)
