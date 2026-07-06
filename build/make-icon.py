#!/usr/bin/env python3
"""Generate build/icon.png (1024) for Claude Swarm Lite — dark console squircle
with a teal terminal chevron and a row of status dots. Throwaway build tool."""
import os
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

out = os.path.join(os.path.dirname(__file__), "icon.png")
img.save(out)
print("wrote", out)
