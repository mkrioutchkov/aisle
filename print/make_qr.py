"""Printable A4 QR sign for the in-store assistant demo, and a sheet of labels with one small QR per aisle.

Usage: python make_qr.py [store-slug] [Store display name]
The URL ends up on paper, so it must never change:
https://mkrioutchkov.github.io/aisle/?store=<slug>
An aisle's label adds &at=<aisle>, so the map starts from where the shopper is standing.
"""
import json
import os
import sys

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

slug = sys.argv[1] if len(sys.argv) > 1 else "brendale"
store = sys.argv[2] if len(sys.argv) > 2 else slug.title()
url = f"https://mkrioutchkov.github.io/aisle/?store={slug}"
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", f"aisle-{slug}-A4.pdf")
os.makedirs(os.path.dirname(out), exist_ok=True)

INK, GREY, LINE, ACCENT = (HexColor(h) for h in ("#14181c", "#5f6b76", "#d5dbe0", "#1e6b45"))
W, H = A4
c = canvas.Canvas(out, pagesize=A4)
c.setTitle(f"Aisle QR sign - {store}")


def centred(txt, y, font, size, color=INK, cs=0.0):
    w = stringWidth(txt, font, size) + cs * (len(txt) - 1)
    t = c.beginText((W - w) / 2, y)
    t.setFont(font, size)
    t.setCharSpace(cs)
    t.setFillColor(color)
    t.textOut(txt)
    c.drawText(t)


centred(f"ANACONDA {store.upper()}  \u00b7  IN-STORE ASSISTANT", 785, "Helvetica-Bold", 9.5, GREY, 1.4)
centred("Can't find it?", 712, "Helvetica-Bold", 48)
centred("Just ask.", 658, "Helvetica-Bold", 48, ACCENT)
centred("Scan, then say or type what you need.", 612, "Helvetica", 16)
centred("Aisle, bay and stock in seconds.", 590, "Helvetica", 16, GREY)

S = 290
x, y = (W - S) / 2, 262
c.setStrokeColor(LINE)
c.setLineWidth(1.5)
c.roundRect(x - 8, y - 8, S + 16, S + 16, 20, stroke=1, fill=0)
qr = QrCodeWidget(url)
qr.barLevel = "M"
qr.barBorder = 3
b = qr.getBounds()
d = Drawing(S, S, transform=[S / (b[2] - b[0]), 0, 0, S / (b[3] - b[1]), 0, 0])
d.add(qr)
renderPDF.draw(d, c, x, y)

centred("Tap the mic and talk, or just type.", 226, "Helvetica-Bold", 13)
centred("TRY", 202, "Helvetica-Bold", 8.5, GREY, 1.6)
chips = ["tent pegs", "kids sleeping bag", "gas canister", "head torch"]
pad, gap, ch, fs = 14, 10, 26, 12
ws = [stringWidth(t, "Helvetica", fs) + 2 * pad for t in chips]
cx = (W - sum(ws) - gap * (len(chips) - 1)) / 2
for t, w in zip(chips, ws):
    c.setFillColor(HexColor("#eef2ef"))
    c.setStrokeColor(LINE)
    c.setLineWidth(0.8)
    c.roundRect(cx, 166, w, ch, ch / 2, stroke=1, fill=1)
    c.setFillColor(INK)
    c.setFont("Helvetica", fs)
    c.drawCentredString(cx + w / 2, 166 + 8.5, t)
    cx += w + gap

c.setStrokeColor(LINE)
c.setLineWidth(0.8)
c.line(56, 100, W - 56, 100)
centred("Demo by Max Krioutchkov, AI engineer, Brisbane  \u00b7  stock, aisles and bays shown are sample data", 82, "Helvetica", 8.5, GREY)
centred(url.replace("https://", ""), 66, "Courier", 9, GREY)
c.showPage()
c.save()
print(out, url)


def draw_qr(canv, link, x, y, size):
    code = QrCodeWidget(link)
    code.barLevel = "M"
    code.barBorder = 2
    bounds = code.getBounds()
    drawing = Drawing(size, size, transform=[size / (bounds[2] - bounds[0]), 0, 0, size / (bounds[3] - bounds[1]), 0, 0])
    drawing.add(code)
    renderPDF.draw(drawing, canv, x, y)


# One label per aisle, eight to a page, to cut out and put on the shelf ends.
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(root, "data", "brendale.json"), encoding="utf-8") as f:
    aisles = json.load(f)["aisles"]
labels_out = os.path.join(os.path.dirname(out), f"aisle-{slug}-labels-A4.pdf")
c = canvas.Canvas(labels_out, pagesize=A4)
c.setTitle(f"Aisle QR labels - {store}")
COLS, ROWS = 2, 4
LW, LH = W / COLS, H / ROWS
for i, a in enumerate(aisles):
    if i and i % (COLS * ROWS) == 0:
        c.showPage()
    col, row = i % COLS, (i // COLS) % ROWS
    lx, ly = col * LW, H - (row + 1) * LH
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    c.rect(lx, ly, LW, LH, stroke=1, fill=0)
    size = 136
    draw_qr(c, f"{url}&at={a['n']}", lx + LW - size - 16, ly + (LH - size) / 2, size)
    tx = lx + 20
    c.setFillColor(GREY)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(tx, ly + LH - 34, f"ANACONDA {store.upper()}")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 34)
    c.drawString(tx, ly + LH - 74, f"Aisle {a['n']}")
    # Long aisle names wrap to two lines rather than running under the code.
    c.setFillColor(GREY)
    c.setFont("Helvetica", 10)
    room, line, lines = LW - size - 56, "", []
    for word in str(a["label"]).split():
        if stringWidth(f"{line} {word}".strip(), "Helvetica", 10) > room and line:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    lines.append(line)
    for n, text in enumerate(lines[:2]):
        c.drawString(tx, ly + LH - 92 - n * 13, text)
    c.setFillColor(ACCENT)
    c.setFont("Helvetica-Bold", 15)
    c.drawString(tx, ly + 44, "Can't find it?")
    c.drawString(tx, ly + 26, "Just ask.")
c.showPage()
c.save()
print(labels_out, f"{len(aisles)} aisles")
