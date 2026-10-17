import sys
from PIL import Image, ImageDraw
SRC, OUT = sys.argv[1], sys.argv[2]
im = Image.open(SRC).convert('RGB')
def P(pts): return [(330 + x / 2, 400 + y / 2) for x, y in pts]
skin = im.getpixel((540, 570)); skin_shadow = im.getpixel((470, 620))
L_open = P([(100,330),(150,290),(230,280),(300,285),(350,312),(365,345),(352,385),(300,410),(240,415),(180,400),(135,368)])
R_open = P([(495,195),(540,140),(600,100),(680,85),(760,72),(815,85),(795,165),(775,225),(740,268),(680,282),(620,285),(560,270),(525,245),(500,220)])
L_line = P([(130,345),(185,385),(250,398),(312,384),(358,352)])
R_line = P([(505,215),(575,258),(660,268),(740,248),(790,195)])
L_half = P([(125,335),(170,295),(230,280),(300,285),(350,312),(365,345),(352,360),(300,370),(240,372),(180,362),(135,350)])
R_half = P([(495,195),(540,148),(600,112),(680,100),(760,105),(800,118),(795,160),(775,195),(740,215),(680,225),(620,225),(560,215),(525,205),(500,200)])
L_hline = P([(130,348),(185,372),(250,378),(312,370),(358,350)])
R_hline = P([(500,205),(575,222),(660,228),(740,215),(792,175)])
import numpy as np
base = np.asarray(im).astype(int)
hair = (base[..., 2] > base[..., 0] + 40) & (base[..., 2] > 140)
def frame(polys, lines, lash):
    m = Image.new('L', im.size, 0); md = ImageDraw.Draw(m)
    for poly in polys: md.polygon(poly, fill=255)
    mask = (np.asarray(m) > 0) & ~hair
    arr = base.copy(); arr[mask] = skin
    f = Image.fromarray(arr.astype('uint8')); d = ImageDraw.Draw(f)
    for cx, cy in P([(683,180),(296,325)]):
        if mask[int(cy), int(cx)] or True: d.ellipse([cx-9, cy-9, cx+9, cy+9], fill=skin)
    for ln in lines: d.line(ln, fill=(20, 16, 24), width=9, joint='curve')
    for (x, y), dx, dy in lash:
        d.line([(x, y), (x + dx, y + dy)], fill=(20, 16, 24), width=6)
    return f
lashC = [(P([(130,345)])[0], -22, -6), (P([(140,358)])[0], -18, 4), (P([(790,195)])[0], 22, -14), (P([(780,212)])[0], 22, -2)]
lashH = [(P([(130,348)])[0], -20, -4), (P([(792,175)])[0], 22, -10)]
frame([L_open, R_open], [L_line, R_line], lashC).save(OUT + '/closed.png')
frame([L_half, R_half], [L_hline, R_hline], lashH).save(OUT + '/half.png')
im.save(OUT + '/open.png')
for n in ('closed', 'half'):
    Image.open(OUT + f'/{n}.png').crop((330, 400, 800, 640)).resize((940, 480)).save(OUT + f'/{n}_crop.png')
