"""Build data/<store>.json from the public anacondastores.com category pages.

Products (name, brand, category, price, image, link) are real. Aisle, bay and stock are
SAMPLE values derived from the product id, so the demo looks plausible without
pretending to be real store data. Only /en-au/c/<slug> pages are fetched (allowed by
robots.txt), one page of 18 tiles each, with a pause between requests.
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
OUT = Path(__file__).resolve().parent.parent / "data"
MAX_CATS_PER_AISLE = 4
# Extra pages for categories the printed sign's example questions depend on
# (tent pegs, kids sleeping bag, gas canister). Default is 1 page of 18 tiles.
PAGES = {"tent-accessories": 3, "sleeping-bags": 3, "camping-fuel-fire": 2}

# aisle, department, aisle label, slug patterns (earlier patterns win)
AISLES = [
    (1, "Camping", "Tents & swags", [r"^camping-tents$", r"^swags$", r"^tent-accessories$", r"^pop-up-tents$"]),
    (2, "Camping", "Sleeping", [r"^sleeping-bags$", r"^airbeds$", r"^foam-mattresses$", r"^hiking-mats$", r"stretcher"]),
    (3, "Camping", "Camp furniture", [r"^camping-chairs$", r"^tables$", r"^camping-stools$", r"^kids-camping-chairs$"]),
    (4, "Camping", "Camp kitchen", [r"^camping-stoves$", r"^cookware$", r"^camp-tableware$", r"^camping-bbqs-smokers$"]),
    (5, "Camping", "Coolers & fridges", [r"^coolers$", r"^cooler-bags$", r"^camping-fridge-freezers$"]),
    (6, "Camping", "Lighting & power", [r"^lanterns$", r"^torches$", r"^headlamps$", r"^portable-power-stations-power-packs$"]),
    (7, "Camping", "Camp essentials", [r"^camping-fuel-fire$", r"^camping-toilets$", r"^camping-water-storage$", r"^first-aid$"]),
    (8, "Hiking", "Packs & navigation", [r"^hiking-packs$", r"^day-packs$", r"^hydration$", r"^hiking-sleeping-bags$"]),
    (9, "Fishing", "Rods", [r"^spinning-rods$", r"^baitcaster-rods$", r"^surf-rods$"]),
    (10, "Fishing", "Reels & combos", [r"^spinning-reels$", r"^baitcaster-reels$", r"^spinning-combos$", r"^kids-combos$"]),
    (11, "Fishing", "Tackle & lures", [r"^soft-plastic-baits$", r"^hard-body-lures$", r"^tackle-boxes$", r"^braid-line$"]),
    (12, "Fishing", "Bait & crabbing", [r"^bait-burley-scents$", r"^crab-pots-bait-nets$", r"^cast-nets$", r"^terminal-tackle$"]),
    (13, "Water sports", "Kayaks & paddle", [r"^kayaks$", r"^paddle-boards$", r"^life-jackets-pfds$", r"^kids-life-jackets-pfds$"]),
    (14, "Beach", "Beach", [r"^beach-tents$", r"^beach-umbrellas$", r"^beach-chairs-loungers$", r"^beach-trolleys-wagons$"]),
    (15, "4WD & caravan", "4WD & caravan", [r"^air-compressors$", r"^4wd-lights$", r"^recovery-accessories$", r"^caravan-levelling-ramps$"]),
    (16, "Cycling", "Bikes & helmets", [r"^bikes$", r"^kids-bikes$", r"^bike-helmets$", r"^bike-lights$"]),
    (17, "Clothing", "Jackets & thermals", [r"^rain-jackets-coats$", r"^mens-jackets-outerwear$", r"^womens-jackets-outerwear$", r"^mens-thermals$"]),
    (18, "Footwear", "Boots & sandals", [r"^hiking-boots-shoes$", r"^sandals$", r"^thongs-slides$", r"^socks$"]),
]
FACILITIES = [
    {"keys": ["toilet", "toilets", "bathroom", "restroom", "loo", "dunny"], "answer": "Toilets are at the back of the store, behind Aisle 9."},
    {"keys": ["service desk", "returns", "refund", "exchange", "help desk", "customer service"], "answer": "The service desk is at the front, right of the entrance. Returns and exchanges are done there."},
    {"keys": ["click and collect", "click & collect", "collect", "pick up", "pickup", "online order"], "answer": "Click & Collect orders are picked up at the service desk, front right."},
    {"keys": ["fitting room", "change room", "changing room", "try on"], "answer": "Fitting rooms are next to Aisle 17, in clothing."},
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
    page = get(f"{BASE}/en-au")
    return sorted(set(re.findall(r'href="(?:https://www\.anacondastores\.com)?/en-au/(?:c/)?([a-z0-9-]+)"', page)))


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
            "id": pid, "name": re.sub(r"\s+", " ", name), "brand": attrs.get("brand", "").title(),
            "cat": attrs.get("list", ""), "price": price,
            "rating": round(float(attrs.get("ratingAvg") or 0), 1) or None,
            "reviews": int(reviews) if reviews.isdigit() else 0,
            "url": url, "img": attrs.get("hero-image-url", ""),
        }


def sample_stock(pid):
    h = int(hashlib.sha1(pid.encode()).hexdigest()[:8], 16)
    return 0 if h % 13 == 0 else 1 + h % 24


def main(store="brendale", name="Brendale"):
    slugs = nav_slugs()
    print("nav slugs", len(slugs))
    products, seen, aisles = [], set(), []
    for aisle, dept, label, pats in AISLES:
        chosen = []
        for pat in pats:
            for s in sorted((s for s in slugs if re.search(pat, s)), key=len):
                if s not in chosen and len(chosen) < MAX_CATS_PER_AISLE:
                    chosen.append(s)
        items = []
        for slug in chosen:
            pages = PAGES.get(slug, 1 if len(chosen) > 1 else 2)
            for q in [""] + [f"?q=%3Arelevance&page={k}" for k in range(1, pages)]:
                try:
                    page = get(f"{BASE}/en-au/c/{slug}{q}")
                except Exception as e:
                    print("  skip", slug, q, repr(e)[:80])
                    continue
                for p in tiles(page):
                    if p["id"] not in seen:
                        seen.add(p["id"])
                        p["cat"] = p["cat"] or slug.replace("-", " ").title()
                        items.append(p)
                time.sleep(0.4)
        items.sort(key=lambda p: (p["cat"], p["name"]))
        for i, p in enumerate(items):
            p.update(dept=dept, aisle=aisle, bay=1 + i * 12 // max(1, len(items)), stock=sample_stock(p["id"]))
        products += items
        aisles.append({"n": aisle, "dept": dept, "label": label, "cats": sorted({p["cat"] for p in items})})
        print(f"aisle {aisle:2} {label:20} {len(items):3}  {','.join(chosen)}")
    data = {"store": name, "slug": store, "sample": True, "source": "anacondastores.com public category pages",
            "generated": time.strftime("%Y-%m-%d"), "aisles": aisles, "facilities": FACILITIES, "products": products}
    OUT.mkdir(exist_ok=True)
    out = OUT / f"{store}.json"
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("products", len(products), "priced", sum(1 for p in products if p["price"]), "bytes", out.stat().st_size)
    for p in products[:: max(1, len(products) // 4)][:4]:
        print("  e.g.", p["name"][:60], "|", p["brand"], "|", p["cat"], "|", p["price"], "| A", p["aisle"], "B", p["bay"], "stock", p["stock"])


if __name__ == "__main__":
    main(*sys.argv[1:3])
