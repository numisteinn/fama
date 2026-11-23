"""Fama brand kit: all flat work. The mark is the Contour ear.

Every band is a chain of tangent circular arcs and lines, drawn by a turtle:
a start point, a heading, and a list of (radius, turn in degrees) or ('L', length).
y is down. A positive turn is clockwise on screen.

Run from brand/fama:
  uv run --no-project --with pillow --with numpy python src/marks.py

Writes mark*.svg, lockup-*.svg/.png, favicon.svg, favicon-*.png, header-proof.png
and src/paths.json (centrelines for studio.py). PNG sheets need Google Chrome.
"""
import json, math, re, subprocess
from pathlib import Path

SRC = Path(__file__).resolve().parent
OUT = SRC.parent
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

COPPER, PEACH = '#935841', '#EABB9F'          # mark on light, mark on dark
CREAM, BLACK, INK = '#FBF3E9', '#0A0A0A', '#284C44'   # word on dark / ground, ground, word on light


# ---------------------------------------------------------------- turtle
def P(start, heading, *segs):
    return {'start': start, 'heading': heading, 'segs': list(segs)}


def walk(path):
    (x, y), h = path['start'], math.radians(path['heading'])
    out = []
    for seg in path['segs']:
        if seg[0] == 'L':
            nx, ny = x + seg[1] * math.cos(h), y + seg[1] * math.sin(h)
            out.append(('L', (x, y), (nx, ny), h))
            x, y = nx, ny
        else:
            R, turn = seg
            sg = 1 if turn > 0 else -1
            cx, cy = x - sg * R * math.sin(h), y + sg * R * math.cos(h)
            h2 = h + math.radians(turn)
            nx, ny = cx + sg * R * math.sin(h2), cy - sg * R * math.cos(h2)
            out.append(('A', (x, y), (nx, ny), R, turn, (cx, cy), h))
            x, y, h = nx, ny, h2
    return out


def end(path):
    w = walk(path)
    turn = sum(s[1] for s in path['segs'] if s[0] != 'L')
    return (w[-1][2] if w else path['start']), path['heading'] + turn


def sample(path, step=3.0):
    pts = []
    for pr in walk(path):
        if pr[0] == 'L':
            (x0, y0), (x1, y1) = pr[1], pr[2]
            n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
            pts += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n)]
        else:
            _, p0, p1, R, turn, (cx, cy), h = pr
            sg = 1 if turn > 0 else -1
            n = max(2, int(abs(math.radians(turn)) * R / step))
            for i in range(n):
                hh = h + math.radians(turn) * i / n
                pts.append((cx + sg * R * math.sin(hh), cy - sg * R * math.cos(hh)))
    pts.append(end(path)[0])
    return pts


def xf(path, k=1.0, rot=0.0, t=(0, 0)):
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    x, y = path['start']
    return {'start': (k * (c * x - s * y) + t[0], k * (s * x + c * y) + t[1]),
            'heading': path['heading'] + rot,
            'segs': [('L', seg[1] * k) if seg[0] == 'L' else (seg[0] * k, seg[1]) for seg in path['segs']]}


def offset(path, d):
    """Parallel curve, d to the right of travel (inside a clockwise turn)."""
    h = math.radians(path['heading'])
    x, y = path['start']
    segs = [seg if seg[0] == 'L' else (seg[0] - d if seg[1] > 0 else seg[0] + d, seg[1]) for seg in path['segs']]
    return {'start': (x - d * math.sin(h), y + d * math.cos(h)), 'heading': path['heading'], 'segs': segs}


def sub(path, a, b):
    """Keep a..b in segment units (1.5 = half way through the second segment)."""
    pre, keep = [], []
    for i, seg in enumerate(path['segs']):
        lo, hi = min(max(a - i, 0), 1), min(max(b - i, 0), 1)
        part = lambda f: ('L', seg[1] * f) if seg[0] == 'L' else (seg[0], seg[1] * f)
        if lo > 0:
            pre.append(part(lo))
        if hi > lo:
            keep.append(part(hi - lo))
    start, heading = end({**path, 'segs': pre})
    return {'start': start, 'heading': heading, 'segs': keep}


def num(v):
    """Short number: 2 decimals, no trailing zeros."""
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return '0' if s == '-0' else s


def d_of(path):
    x, y = path['start']
    out = [f'M{num(x)} {num(y)}']
    for pr in walk(path):
        if pr[0] == 'L':
            out.append(f'L{num(pr[2][0])} {num(pr[2][1])}')
        else:
            _, p0, p1, R, turn, c, h = pr
            out.append(f'A{num(R)} {num(R)} 0 {int(abs(turn) > 180)} {int(turn > 0)} {num(p1[0])} {num(p1[1])}')
    return ' '.join(out)


def bbox(els, step=0.25):
    xs, ys = [], []
    for e in els:
        r = e['w'] / 2
        for x, y in sample(e['path'], step):
            xs += [x - r, x + r]
            ys += [y - r, y + r]
    return min(xs), min(ys), max(xs), max(ys)


# ---------------------------------------------------------------- the mark
# Design units = the units of mark.svg. A left ear, the face is to the left.
R = 300        # helix crown radius (centreline). Antihelix R - D = 188. Concha R - 2D = 76.
S = 58         # stroke
D = 112        # band step, centre to centre. Gap = D - S = 54.
A0 = 205       # math angle (y up) where the three bands start, before the tilt
TILT = 12      # the crown leans back
HELIX = [(R, 225), (560, 28), (190, 62), (88, 100)]   # crown, back, low back, lobe: (radius, turn)
ANTIHELIX_STOP = 2.5                                  # the antihelix stops half way down the low back
CONCHA_TURN = 250
MARGIN = 21    # viewBox margin
VIEW = (2 * (R + S / 2 + MARGIN), 773)                # 700 x 773, crown centre at (350, 350)


def arc_at(r, a0, sweep, c=(0, 0)):
    """Clockwise arc of radius r around c, from math angle a0 (y up), sweep degrees."""
    a = math.radians(a0)
    return P((c[0] + r * math.cos(a), c[1] - r * math.sin(a)), 90 - a0, (r, sweep))


def contour():
    """Three parallel curves of one ear outline, in design units, crown centre at (0, 0), no tilt."""
    helix = arc_at(R, A0, HELIX[0][1])
    helix['segs'] += HELIX[1:]
    return [{'path': helix, 'w': S},
            {'path': offset(sub(helix, 0.0, ANTIHELIX_STOP), D), 'w': S},
            {'path': arc_at(R - 2 * D, A0, CONCHA_TURN), 'w': S}]


def master():
    """The mark in the viewBox of mark.svg."""
    c = R + S / 2 + MARGIN
    return [{'path': xf(e['path'], rot=TILT, t=(c, c)), 'w': e['w']} for e in contour()]


def fit(els, box=1024, clear=128):
    """Scale and centre the mark in a square box (for the icon)."""
    x0, y0, x1, y1 = bbox(els)
    k = (box - 2 * clear) / max(x1 - x0, y1 - y0)
    t = (box / 2 - k * (x0 + x1) / 2, box / 2 - k * (y0 + y1) / 2)
    return [{'path': xf(e['path'], k=k, t=t), 'w': e['w'] * k} for e in els]


def gap(els):
    best = 1e9
    pts = [sample(e['path'], 2) for e in els]
    for i in range(len(els)):
        for j in range(i + 1, len(els)):
            dmin = min(math.hypot(ax - bx, ay - by) for ax, ay in pts[i] for bx, by in pts[j])
            best = min(best, dmin - els[i]['w'] / 2 - els[j]['w'] / 2)
    return best


def paths_svg(els, indent='  '):
    return '\n'.join(f'{indent}<path d="{d_of(e["path"])}"/>' for e in els)


def mark_svg(colour):
    w, h = VIEW
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{num(w)}" height="{num(h)}" '
            f'viewBox="0 0 {num(w)} {num(h)}" fill="none" '
            f'stroke="{colour}" stroke-width="{S}" stroke-linecap="round">\n{paths_svg(master())}\n</svg>\n')


# ---------------------------------------------------------------- lockup
FONT = json.loads((SRC / 'fraunces-540.json').read_text())   # "fama", Fraunces wght 540, outlined
STEM = 245       # stem of "m" in font units (upm 2000)
RATIO = 0.55     # mark stroke = RATIO x stem
SPACE = 240      # mark to word, design units
K = S / (RATIO * STEM)   # font units -> design units


def glyph_d(d, ox, oy):
    """Bake translate(ox, oy) scale(K, -K) into an absolute M/L/Q/H/V/Z path."""
    out, pts = [], []
    for cmd, body in re.findall(r'([MLQHVZ])([^MLQHVZ]*)', d):
        v = [float(n) for n in re.findall(r'-?[\d.]+(?:e-?\d+)?', body)]
        if cmd == 'H':
            out.append('H' + num(ox + K * v[0]))
            pts.append((ox + K * v[0], pts[-1][1]))
        elif cmd == 'V':
            out.append('V' + num(oy - K * v[0]))
            pts.append((pts[-1][0], oy - K * v[0]))
        elif cmd == 'Z':
            out.append('Z')
        else:
            xy = [(ox + K * v[i], oy - K * v[i + 1]) for i in range(0, len(v), 2)]
            if cmd == 'Q':   # sample the curve for the ink box
                p0 = pts[-1]
                for i in range(0, len(xy), 2):
                    c, p1 = xy[i], xy[i + 1]
                    pts += [tuple((1 - t) ** 2 * a + 2 * t * (1 - t) * b + t * t * e for a, b, e in zip(p0, c, p1))
                            for t in (.25, .5, .75)]
                    p0 = p1
                pts.append(p0)
            else:
                pts += xy
            out.append(cmd + ' '.join(f'{num(x)} {num(y)}' for x, y in xy))
    return ''.join(out), pts


def lockup():
    """Mark + "fama". The x-height is centred on the mark. Returns (W, H, mark, glyph paths)."""
    mark = master()
    x0, y0, x1, y1 = bbox(mark)
    wx = x1 + SPACE
    base = (y0 + y1) / 2 + FONT['xHeight'] * K / 2
    glyphs, pts = [], []
    left = None
    for g in FONT['glyphs']:
        d, p = glyph_d(g['d'], 0, 0)
        left = min(x for x, _ in p) if left is None else left
        glyphs.append(g)
    ox = wx - left                                   # the ink of "f" starts SPACE after the mark
    out = []
    for g in glyphs:
        d, p = glyph_d(g['d'], ox + g['x'] * K, base)
        out.append(d)
        pts += p
    top = min(y0, min(y for _, y in pts))
    bottom = max(y1, max(y for _, y in pts))
    right = max(x for x, _ in pts)
    dy = MARGIN - top                                # shift so the ink box has the same margin all round
    if abs(dy) > 1e-6:
        mark = [{'path': xf(e['path'], t=(0, dy)), 'w': e['w']} for e in mark]
        out = [glyph_d(g['d'], ox + g['x'] * K, base + dy)[0] for g in glyphs]
    return math.ceil(right + MARGIN), math.ceil(bottom + dy + MARGIN), mark, out


def lockup_svg(mark_colour, word_colour, height=None):
    W, H, mark, glyphs = lockup()
    dim = f' width="{num(height * W / H)}" height="{num(height)}"' if height else f' width="{W}" height="{H}"'
    word = '\n'.join(f'    <path d="{d}"/>' for d in glyphs)
    return (f'<svg xmlns="http://www.w3.org/2000/svg"{dim} viewBox="0 0 {W} {H}">\n  <title>Fama</title>\n'
            f'  <g fill="none" stroke="{mark_colour}" stroke-width="{S}" stroke-linecap="round">\n'
            f'{paths_svg(mark, "    ")}\n  </g>\n  <g fill="{word_colour}">\n{word}\n  </g>\n</svg>\n')


def shoot(html, png, w, h, scale=1):
    src = SRC / ('.' + png.stem + '.html')
    src.write_text(html)
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    f'--force-device-scale-factor={scale}', f'--window-size={w},{h}',
                    f'--screenshot={png}', f'file://{src}'], check=True, capture_output=True)
    src.unlink()


# ---------------------------------------------------------------- favicons (flat edges snapped to the grid)
# Units are pixels. Each size is its own drawing, not a scaled master. The stroke and the gap are
# whole pixels. The crown centre sits on a pixel corner and the radii are chosen so that the top,
# left and right edges of every band lie on pixel edges. Each front end is cut flat on a pixel row.
# The rows step down from the concha to the helix, to follow the 13 degree line of the master.
# The back and low-back radii are solved so that the bottom and the left edge of the lobe also lie
# on pixel edges.
#        centre    stroke gap  inner r  front cuts, helix first  back   low    lobe (r, turn)  concha turn
FAVICON = {
    16: ((8, 7),   2,     2,   2,       (9, 8),                  12.9,  3.55,  (2, 90),        200),   # two bands
    32: ((16, 15), 3,     2,   2.5,     (18, 17, 16),            19.75, 9.3,   (3.5, 100),     237),
    48: ((24, 22), 4,     3,   5,       (27, 26, 24),            33.4,  12.75, (5, 100),       237),
}


def fav_band(c, r, y_cut, segs):
    """Start at the flat front cut, go up to the crown, then follow segs."""
    return P((c[0] - r, y_cut), -90, ('L', y_cut - c[1]), *segs)


def favicon(size):
    """Returns (stroke, bands) in pixels."""
    c, w, g, r_in, cuts, back, low, lobe, concha = FAVICON[size]
    step = w + g
    n = len(cuts)                                   # bands
    r = r_in + (n - 1) * step
    crown = 180 - (A0 - TILT) + HELIX[0][1]         # ends at the same angle as the master crown: 212
    bands = [fav_band(c, r, cuts[0], [(r, crown), (back, HELIX[1][1]), (low, HELIX[2][1]), lobe])]
    if n == 3:
        bands.append(fav_band(c, r - step, cuts[1], [(r - step, crown), (back - step, HELIX[1][1]),
                                                 (low - step, HELIX[2][1] / 2)]))
    bands.append(fav_band(c, r_in, cuts[-1], [(r_in, concha)]))
    return w, bands


def raster(bands, w, size, ss=8):
    """Exact-area antialiasing: ss x ss samples per pixel, butt caps. Returns an alpha array."""
    import numpy as np
    n = size * ss
    ys, xs = np.mgrid[0:n, 0:n]
    px, py = (xs + .5) / ss, (ys + .5) / ss
    cover = np.zeros((n, n), bool)
    for b in bands:
        pts = np.array(sample(b, 0.02))
        best = np.full((n, n), 1e9)
        idx = np.zeros((n, n), int)
        for i in range(0, len(pts), 256):           # chunked nearest-point search
            chunk = pts[i:i + 256]
            d = (px[..., None] - chunk[:, 0]) ** 2 + (py[..., None] - chunk[:, 1]) ** 2
            j = d.argmin(-1)
            dm = np.take_along_axis(d, j[..., None], -1)[..., 0]
            better = dm < best
            best = np.where(better, dm, best)
            idx = np.where(better, i + j, idx)
        inside = best <= (w / 2) ** 2
        for at, nb in ((0, 1), (len(pts) - 1, len(pts) - 2)):   # butt caps: cut what lies past an end
            t = pts[at] - pts[nb]
            past = (px - pts[at][0]) * t[0] + (py - pts[at][1]) * t[1] > 0
            inside &= ~((idx == at) & past)
        cover |= inside
    return cover.reshape(size, ss, size, ss).mean((1, 3))


def favicon_png(size, colour, path):
    import numpy as np
    from PIL import Image
    w, bands = favicon(size)
    a = raster(bands, w, size)
    rgb = [int(colour[i:i + 2], 16) for i in (1, 3, 5)]
    px = np.zeros((size, size, 4), np.uint8)
    px[..., :3] = rgb
    px[..., 3] = np.round(a * 255)
    Image.fromarray(px, 'RGBA').save(path)


def favicon_svg():
    w, bands = favicon(32)
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">\n'
            f'  <style>g{{stroke:{COPPER}}}@media (prefers-color-scheme:dark){{g{{stroke:{PEACH}}}}}</style>\n'
            f'  <g fill="none" stroke-width="{num(w)}">\n{paths_svg([{"path": b} for b in bands], "    ")}\n  </g>\n</svg>\n')


# ---------------------------------------------------------------- proofs
def header_proof():
    """The lockup at 24 px and 32 px mark height. Top: 1x and 2x at real size. Bottom: the 1x pixels at 300%."""
    from PIL import Image
    W, H, _, _ = lockup()
    y0, y1 = bbox(master())[1], bbox(master())[3]
    rows = []
    for bg, mc, wc in ((BLACK, PEACH, CREAM), (CREAM, COPPER, INK)):
        cells = ''.join(f'<div class="bar">{lockup_svg(mc, wc, px * H / (y1 - y0))}<span>{px}</span></div>'
                        for px in (24, 32))
        rows.append(f'<div class="row" style="background:{bg}">{cells}</div>')
    css = ('body{margin:0;font:11px Helvetica,Arial,sans-serif;color:#8a8178}svg{display:block}'
           '.row{display:flex;gap:48px;padding:0 28px;height:ROWpx;align-items:center}'
           '.bar{display:flex;align-items:center;gap:14px}')
    w, h = 440, 160

    def shot(scale, row):
        tmp = SRC / f'.header{scale}{row}.png'
        shoot(f'<style>{css.replace("ROW", str(row))}</style>' + ''.join(rows), tmp, w, 2 * row, scale)
        im = Image.open(tmp).convert('RGB')
        tmp.unlink()
        return im

    sheet = Image.new('RGB', (3 * w, 2 * h + 3 * h), BLACK)
    sheet.paste(shot(1, 160), (0, 0))                                               # 1x, real size
    sheet.paste(shot(2, 80), (w, 0))                                                # 2x, real size
    sheet.paste(shot(1, 80).resize((3 * w, 3 * h), Image.Resampling.NEAREST), (0, 2 * h))   # 1x at 300%
    sheet.save(OUT / 'header-proof.png')


def write():
    (OUT / 'mark.svg').write_text(mark_svg(COPPER))
    (OUT / 'mark-dark.svg').write_text(mark_svg(PEACH))
    (OUT / 'mark-mono.svg').write_text(mark_svg('currentColor'))
    W, H, _, _ = lockup()
    for tone, bg, mc, wc in (('dark', BLACK, PEACH, CREAM), ('light', CREAM, COPPER, INK)):
        (OUT / f'lockup-{tone}.svg').write_text(lockup_svg(mc, wc))
        h = 400                                       # PNG: lockup 400 px high on its ground
        html = (f'<body style="margin:0;background:{bg};display:grid;place-items:center;height:640px">'
                f'{lockup_svg(mc, wc, h)}</body>')
        shoot(html, OUT / f'lockup-{tone}.png', 1600, 640)
    (OUT / 'favicon.svg').write_text(favicon_svg())
    for size in (16, 32, 48):
        favicon_png(size, COPPER, OUT / f'favicon-{size}.png')
        favicon_png(size, PEACH, OUT / f'favicon-{size}-dark.png')
    header_proof()
    icon = fit(master())
    (SRC / 'paths.json').write_text(json.dumps(
        [{'w': round(e['w'], 2), 'points': [(round(x, 2), round(y, 2)) for x, y in sample(e['path'], 2.0)]}
         for e in icon]))
    m = master()
    x0, y0, x1, y1 = bbox(m)
    print(json.dumps({'viewBox': VIEW, 'mark': [round(x1 - x0, 2), round(y1 - y0, 2)],
                      'margins': [round(v, 2) for v in (x0, y0, VIEW[0] - x1, VIEW[1] - y1)],
                      'gap': round(gap(m), 2), 'lockup': [W, H],
                      'favicon bbox': {s: [round(v, 2) for v in bbox([{'path': b, 'w': favicon(s)[0]}
                                                                      for b in favicon(s)[1]], 0.01)]
                                       for s in (16, 32, 48)}}))


if __name__ == '__main__':
    write()
