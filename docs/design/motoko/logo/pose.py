"""Render a transparent PNG/WebP pose as Motoko dot art: python3 pose.py SRC OUT LONG_SIDE_DOTS [CELL_PX]"""
import sys
import numpy as np
from PIL import Image, ImageDraw
SRC, OUT, LONG = sys.argv[1], sys.argv[2], int(sys.argv[3])
CELL = int(sys.argv[4]) if len(sys.argv) > 4 else 5
INK = (242, 235, 223); PINK = (255, 95, 162)
def bayer(n):
    m = np.array([[0, 2], [3, 1]])
    while m.shape[0] < n:
        m = np.block([[4*m, 4*m+2], [4*m+3, 4*m+1]])
    return (m + 0.5) / (n * n)
BAYER = bayer(8)
im = Image.open(SRC).convert('RGBA')
a = np.asarray(im).astype(float) / 255
H, W = a.shape[:2]
s = max(H, W) / LONG
rows, cols = int(round(H / s)), int(round(W / s))
col = np.zeros((rows, cols, 3)); cov = np.zeros((rows, cols)); pink = np.zeros((rows, cols))
for j in range(rows):
    for i in range(cols):
        blk = a[int(j*s):int((j+1)*s), int(i*s):int((i+1)*s)]
        fg = blk[..., 3] > 0.5
        cov[j, i] = fg.mean() if fg.size else 0
        if fg.any():
            px = blk[fg][:, :3]; col[j, i] = px.mean(0)
            r, g, b = px[:, 0], px[:, 1], px[:, 2]
            pink[j, i] = ((r > .65) & (g < .5) & (b > .45) & (r - g > .3)).mean()
lum = 0.299*col[..., 0] + 0.587*col[..., 1] + 0.114*col[..., 2]
is_hair = (col[..., 2] > col[..., 0] + 0.25) & (col[..., 2] > 0.45) & (col[..., 2] - col[..., 1] > 0.15)
v_hair = np.clip(0.18 + (col[..., 2] - 0.6) * 1.6 + (col[..., 1] - 0.35) * 0.8, 0.08, 0.85)
v = np.where(is_hair, v_hair, np.where(lum < 0.1, 0, np.clip((lum - 0.1) / 0.85, 0, 1) ** 1.2)) * np.clip(cov * 1.4, 0, 1)
v = np.where(pink > 0.12, 1, v)
def render(style):
    SS = 4
    img = Image.new('RGBA', (cols * CELL * SS, rows * CELL * SS), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    for j in range(rows):
        for i in range(cols):
            if cov[j, i] < 0.25: continue
            cx = (i + .5) * CELL * SS; cy = (j + .5) * CELL * SS
            if style == 'mono':
                if v[j, i] <= BAYER[j % 8, i % 8]: continue
                r = CELL * SS * 0.38; c = PINK if pink[j, i] > 0.12 else INK
            else:
                if lum[j, i] < 0.1: continue
                c = tuple(int(min(255, x * 255 * 1.18)) for x in col[j, i])
                r = CELL * SS * (0.25 + 0.21 * min(1, lum[j, i] * 1.15))
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    return img.resize((cols * CELL, rows * CELL), Image.LANCZOS)
for style in ('mono', 'color'):
    out = render(style)
    out.save(f'{OUT}-{style}.webp', quality=90, method=6, alpha_quality=90)
print(OUT, cols, 'x', rows)
