"""Turn Motoko poses into coloured Unicode Braille text (2x4 dots per character), in the manner of
utpalsinghdev/pi-custom-header (MIT). Writes one JSON file with every pose and its blink frames.

python3 braille.py OUT.json  (pose list below; paths relative to this script's folder)
"""
import json, sys
import numpy as np
from PIL import Image, ImageDraw

# Noto Sans Symbols 2: braille advance 0.70 em, dot centres 0.25 em apart down, so with
# line-height 1.0 dots are on average 0.35 em apart across and 0.25 em down.
X_OVER_Y = 0.35 / 0.25
MAX_LINES, MAX_COLS = 60, 112
BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]]  # [dot row][dot col]
B8 = None

def bayer(n):
    m = np.array([[0, 2], [3, 1]])
    while m.shape[0] < n:
        m = np.block([[4*m, 4*m+2], [4*m+3, 4*m+1]])
    return (m + 0.5) / (n * n)
B8 = bayer(8)

def load(path):
    im = Image.open(path)
    if im.mode == 'RGBA':
        a = np.asarray(im).astype(float) / 255
        return a[..., :3], a[..., 3] > 0.5
    im = im.convert('RGB'); work = im.copy()
    for c in [(0, 0), (im.width-1, 0), (0, im.height-1), (im.width-1, im.height-1), (im.width//2, 0)]:
        ImageDraw.floodfill(work, c, (255, 0, 255), thresh=40)
    bg = np.all(np.asarray(work) == (255, 0, 255), axis=-1)
    return np.asarray(im).astype(float) / 255, ~bg

def grid(shape):
    H, W = shape
    lines = MAX_LINES
    sy = H / (lines * 4); sx = sy * X_OVER_Y
    cols = int(round(W / sx / 2))
    if cols > MAX_COLS:
        cols = MAX_COLS; sx = W / (cols * 2); sy = sx / X_OVER_Y; lines = int(round(H / sy / 4))
    return lines, cols, sy, sx

def frame(rgb, fg, lines, cols, sy, sx):
    R, C = lines * 4, cols * 2
    col = np.zeros((R, C, 3)); cov = np.zeros((R, C)); pink = np.zeros((R, C))
    for j in range(R):
        for i in range(C):
            y0, y1 = int(j*sy), max(int((j+1)*sy), int(j*sy)+1)
            x0, x1 = int(i*sx), max(int((i+1)*sx), int(i*sx)+1)
            f = fg[y0:y1, x0:x1]
            cov[j, i] = f.mean() if f.size else 0
            if f.any():
                px = rgb[y0:y1, x0:x1][f]; col[j, i] = px.mean(0)
                r, g, b = px[:, 0], px[:, 1], px[:, 2]
                pink[j, i] = ((r > .65) & (g < .5) & (b > .45) & (r - g > .3)).mean()
    lum = 0.299*col[..., 0] + 0.587*col[..., 1] + 0.114*col[..., 2]
    hair = (col[..., 2] > col[..., 0] + 0.25) & (col[..., 2] > 0.45) & (col[..., 2] - col[..., 1] > 0.15)
    # line-art style: dots on inside the figure, gaps for the ink lines and the darkest shading;
    # colour carries the tone. Mid-dark cloth is dithered so folds still show.
    v = np.where(lum < 0.13, 0.0, np.where(lum < 0.3, 0.35 + (lum - 0.13) * 2.6, 1.0))
    v = np.where(hair, np.where(lum < 0.16, 0.0, 1.0), v)
    v = np.where(pink > 0.12, 1, v) * np.clip(cov * 1.6, 0, 1)
    on = (v > B8[np.arange(R)[:, None] % 8, np.arange(C)[None, :] % 8]) & (cov > 0.2)
    text, colours = [], []
    for L in range(lines):
        row, crow = '', []
        for c in range(cols):
            code = 0; acc = np.zeros(3); n = 0; pk = 0; anyc = np.zeros(3); an = 0
            for dy in range(4):
                for dx in range(2):
                    j, i = L*4 + dy, c*2 + dx
                    if cov[j, i] > 0.2:
                        anyc += col[j, i]; an += 1
                    if on[j, i]:
                        code |= BITS[dy][dx]
                        acc += col[j, i]; n += 1
                        if pink[j, i] > 0.12: pk += 1
            colour = None
            if pk and pk * 3 >= n: colour = 'pink'
            elif n: colour = acc / n
            elif an: colour = anyc / an
            row += chr(0x2800 + code)
            crow.append(colour)
        text.append(row); colours.append(crow)
    return text, colours

def lift(c):
    # brighter and a little more saturated, so the colours read on the dark page; keep hue
    import colorsys
    h, l, sat = colorsys.rgb_to_hls(*np.clip(c, 0, 1))
    l = min(0.88, l * 1.05) if l > 0.5 else max(l * 1.5, 0.45)
    sat = min(1.0, sat * 1.2)
    return np.array(colorsys.hls_to_rgb(h, min(l, 0.9), sat))

def build(name, alt, paths):
    loaded = {k: load(p) for k, p in paths.items()}
    lines, cols, sy, sx = grid(loaded['open'][0].shape[:2])
    frames = {k: frame(rgb, fg, lines, cols, sy, sx) for k, (rgb, fg) in loaded.items()}
    # one palette per pose, shared by its frames
    samples = [lift(c) for _, cl in frames.values() for row in cl for c in row if c is not None and not isinstance(c, str)]
    arr = (np.array(samples)[None, :, :] * 255).astype('uint8')
    q = Image.fromarray(arr).quantize(colors=27, method=Image.Quantize.MEDIANCUT)
    pal = np.vstack([np.array(q.getpalette()[:27*3]).reshape(-1, 3), [[255, 95, 162]]])  # last: iris pink
    def nearest(c):
        if isinstance(c, str): return len(pal) - 1
        return int(np.argmin(((pal[:-1] - lift(c) * 255) ** 2).sum(1)))
    out = {'name': name, 'alt': alt, 'cols': cols, 'lines': lines,
           'palette': ['#%02x%02x%02x' % tuple(int(x) for x in p) for p in pal], 'frames': {}}
    for k, (text, cl) in frames.items():
        runs = []
        for row, crow in zip(text, cl):
            rr = []; cur = None
            for ch, c in zip(row, crow):
                ci = cur if (ch == '⠀' or c is None) and cur is not None else (nearest(c) if c is not None else 0)
                if rr and rr[-1][1] == ci: rr[-1][0] += 1
                else: rr.append([1, ci])
                cur = ci
            runs.append(rr)
        out['frames'][k] = {'text': text, 'runs': runs}
    return out

POSES = [
    ('portrait', 'Motoko in Braille dot art, smiling, blinking now and then',
     {'open': 'logo/open.png', 'half': 'logo/half.png', 'closed': 'logo/closed.png'}),
    ('wine', 'Motoko in Braille dot art, holding a glass of white wine', {'open': '../images/4.webp'}),
    ('glance', 'Motoko in Braille dot art, glancing sideways', {'open': '../images/5.webp'}),
    ('shrug', 'Motoko in Braille dot art, shrugging in a work suit with red mechanical arms', {'open': '../images/6.webp'}),
    ('visor', 'Motoko in Braille dot art, wearing a visor and tapping her temple', {'open': '../images/7.webp'}),
]
data = {'font': 'Noto Sans Symbols 2', 'lineHeight': 1.0, 'poses': [build(*p) for p in POSES]}
json.dump(data, open(sys.argv[1], 'w'), ensure_ascii=False, separators=(',', ':'))
for p in data['poses']:
    print(p['name'], p['cols'], 'x', p['lines'], 'runs/frame', sum(len(r) for r in p['frames']['open']['runs']))
