"""Printable A4 QR sign for the in-store assistant demo.

Usage: python make_qr.py [store-slug] [Store display name]
The URL ends up on paper, so it must never change:
https://mkrioutchkov.github.io/aisle/?store=<slug>
"""
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
