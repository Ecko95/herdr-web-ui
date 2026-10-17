import sys, os
ALPHA = bool(os.environ.get('ALPHA'))
import numpy as np
from PIL import Image, ImageDraw
D = sys.argv[1]; N = int(sys.argv[2]); CELL = int(sys.argv[3])
CROP = tuple(int(x) for x in sys.argv[6].split(',')) if len(sys.argv) > 6 else None
BG = (24, 22, 19); INK = (242, 235, 223); PINK = (255, 95, 162)
B2 = np.array([[0, 2], [3, 1]])
def bayer(n):
    m = B2
    while m.shape[0] < n:
        k = m.shape[0]; m = np.block([[4*m, 4*m+2], [4*m+3, 4*m+1]])
    return m
BAYER = (bayer(8) + 0.5) / 64
def load(name):
    im = Image.open(f'{D}/{name}.png').convert('RGB')
    if CROP: im = im.crop(CROP)
    # background: flood-fill near-white from the corners
    work = im.copy()
    for c in [(0,0),(im.width-1,0),(0,im.height-1),(im.width-1,im.height-1),(im.width//2,0)]:
        ImageDraw.floodfill(work, c, (255,0,255), thresh=40)
    a = np.asarray(im).astype(float) / 255
    bg = np.all(np.asarray(work) == (255,0,255), axis=-1)
    return a, bg
def cells(a, bg):
    H = a.shape[0]; s = H / N
    out = np.zeros((N, N, 3)); cov = np.zeros((N, N)); pink = np.zeros((N, N))
    for j in range(N):
        for i in range(N):
            y0, y1, x0, x1 = int(j*s), int((j+1)*s), int(i*s), int((i+1)*s)
            blk = a[y0:y1, x0:x1]; fg = ~bg[y0:y1, x0:x1]
            cov[j, i] = fg.mean()
            if fg.any():
                px = blk[fg]; out[j, i] = px.mean(0)
                r, g, b = px[:,0], px[:,1], px[:,2]
                pink[j, i] = ((r > .65) & (g < .5) & (b > .45) & (r - g > .3)).mean()
    return out, cov, pink
def render(name, style):
    a, bg = load(name)
    col, cov, pink = cells(a, bg)
    lum = (0.299*col[...,0] + 0.587*col[...,1] + 0.114*col[...,2])
    blue = np.clip(col[...,2] - col[...,0] - 0.15, 0, 1)
    is_hair = (col[...,2] > col[...,0] + 0.25) & (col[...,2] > 0.45)
    v_hair = np.clip(0.18 + (col[...,2] - 0.6) * 1.6 + (col[...,1] - 0.35) * 0.8, 0.08, 0.85)
    v = np.where(is_hair, v_hair, np.where(lum < 0.1, 0, np.clip((lum - 0.1) / 0.85, 0, 1) ** 1.2)) * np.clip(cov * 1.4, 0, 1)
    v = np.where(pink > 0.12, 1, v)
    SS = 4; W = N * CELL * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0)) if ALPHA else Image.new('RGB', (W, W), BG); d = ImageDraw.Draw(img)
    for j in range(N):
        for i in range(N):
            if cov[j, i] < 0.25: continue
            cx = (i + .5) * CELL * SS; cy = (j + .5) * CELL * SS
            if style == 'mono':
                if v[j, i] <= BAYER[j % 8, i % 8]: continue
                r = CELL * SS * 0.38
                c = PINK if pink[j, i] > 0.12 else INK
            else:
                if lum[j, i] < 0.1: continue
                c = tuple(int(min(255, x * 255 * 1.08)) for x in col[j, i])
                r = CELL * SS * (0.2 + 0.24 * min(1, lum[j, i] * 1.15))
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    return img.resize((N * CELL, N * CELL), Image.LANCZOS)
style = sys.argv[4]
frames = {n: render(n, style) for n in ('open', 'half', 'closed')}
seq = [('open', 3000), ('half', 70), ('closed', 120), ('half', 70), ('open', 4200),
       ('half', 60), ('closed', 90), ('half', 60), ('open', 260), ('half', 60), ('closed', 90), ('half', 60)]
imgs = [frames[n] for n, _ in seq]; durs = [t for _, t in seq]
out = sys.argv[5]
if not ALPHA: imgs[0].save(out + '.gif', save_all=True, append_images=imgs[1:], duration=durs, loop=0, optimize=True)
imgs[0].save(out + '.webp', save_all=True, append_images=imgs[1:], duration=durs, loop=0, quality=90, method=6, minimize_size=True, **({'lossless': False, 'alpha_quality': 90} if ALPHA else {}))
frames['open'].save(out + '-open.png'); frames['closed'].save(out + '-closed.png')
