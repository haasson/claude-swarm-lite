#!/usr/bin/env python3
"""Generate build/icon.png (1024) for Claude Swarm Lite — dark console squircle
with a teal terminal chevron and a row of status dots. Also writes build/icon.ico
as classic BMP entries (not PNG-compressed) so Wine/rcedit on CI can embed it."""
import os
import struct
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# --- vertical gradient background ------------------------------------------
grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
top = (27, 32, 39)     # #1b2027
bot = (13, 15, 18)     # #0d0f12
for y in range(S):
    t = y / (S - 1)
    r = round(top[0] + (bot[0] - top[0]) * t)
    g = round(top[1] + (bot[1] - top[1]) * t)
    b = round(top[2] + (bot[2] - top[2]) * t)
    gd.line([(0, y), (S, y)], fill=(r, g, b, 255))

# rounded-rect mask (Big Sur style: ~96px margin, r~186)
m = 96
rect = [m, m, S - m, S - m]
radius = 186
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(rect, radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
# subtle border
d.rounded_rectangle(rect, radius=radius, outline=(42, 51, 60, 255), width=3)

# --- teal terminal chevron ❯ ------------------------------------------------
teal = (63, 208, 201, 255)
w = 72
chev = [(430, 352), (612, 470), (430, 588)]
d.line(chev, fill=teal, width=w, joint="curve")
# rounded caps
for (cx, cy) in (chev[0], chev[2]):
    d.ellipse([cx - w // 2, cy - w // 2, cx + w // 2, cy + w // 2], fill=teal)

# --- status dots row (green / amber / teal) --------------------------------
dots = [(392, 690, (74, 222, 128)), (512, 690, (224, 165, 63)), (632, 690, (63, 208, 201))]
rr = 46
for (cx, cy, col) in dots:
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=col + (255,))

here = os.path.dirname(__file__)
out = os.path.join(here, "icon.png")
img.save(out)
print("wrote", out)


def dib_for(im: Image.Image) -> bytes:
    """Uncompressed 32bpp XOR + empty AND mask (ICO-compatible DIB)."""
    im = im.convert("RGBA")
    w, h = im.size
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = im.getpixel((x, y))
            xor += bytes((b, g, r, a))
    and_row = ((w + 31) // 32) * 4
    and_mask = bytes(and_row * h)
    header = struct.pack(
        "<IIIHHIIIIII",
        40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0,
    )
    return header + xor + and_mask


def write_bmp_ico(path: str, source: Image.Image, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    payloads = [dib_for(source.resize((s, s), Image.Resampling.LANCZOS)) for s in sizes]
    count = len(sizes)
    buf = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    for s, payload in zip(sizes, payloads):
        bw = 0 if s >= 256 else s
        bh = 0 if s >= 256 else s
        buf += struct.pack("<BBBBHHII", bw, bh, 0, 0, 1, 32, len(payload), offset)
        offset += len(payload)
    for payload in payloads:
        buf += payload
    with open(path, "wb") as f:
        f.write(buf)


ico_path = os.path.join(here, "icon.ico")
write_bmp_ico(ico_path, img)
print("wrote", ico_path)
