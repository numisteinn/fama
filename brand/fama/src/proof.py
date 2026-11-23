"""Fama brand kit: the proof sheet.

Run from brand/fama (after marks.py, studio.py and icons.py):
  uv run --no-project --with pillow --with numpy python src/proof.py

Writes proof.png. Dark first, cream second.
"""
import base64, io, sys
from pathlib import Path
from PIL import Image

sys.dont_write_bytecode = True
import marks

SRC = Path(__file__).resolve().parent
OUT = SRC.parent
LANCZOS = Image.Resampling.LANCZOS


def ios_mask(size):
    """iOS continuous-corner mask (superellipse, n = 5)."""
    n = size * 4
    m = Image.new('L', (n, n))
    m.putdata([255 if abs((i % n + .5 - n / 2) / (n / 2)) ** 5 + abs((i // n + .5 - n / 2) / (n / 2)) ** 5 <= 1 else 0
               for i in range(n * n)])
    return m.resize((size, size), LANCZOS)


def home_icon(name, size):
    """The icon as the home screen shows it: scaled to size, with the mask. Returns an <img>."""
    im = Image.open(OUT / name).convert('RGB').resize((size, size), LANCZOS).convert('RGBA')
    im.putalpha(ios_mask(size))
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return (f'<img width="{size}" height="{size}" '
            f'src="data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}">')


def cell(body, label):
    return f'<figure>{body}<figcaption>{label}</figcaption></figure>'


CSS = """
body{margin:0;width:2080px;background:#0A0A0A;font:12px Helvetica,Arial,sans-serif;color:#8a8178}
img,svg{display:block} figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:14px}
.row{display:flex} .half{width:1040px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:44px}
.dark{background:#0A0A0A} .cream{background:#FBF3E9} .white{background:#FFFFFF} .tab{background:#202124}
.splash{background:#0B0B0C} .wall{background:#000}
.icons{height:600px} .lock{height:400px;flex-direction:column;gap:40px} .lock .small{display:flex;gap:56px;align-items:center}
.fav{height:480px;align-items:flex-end;gap:32px;padding-bottom:40px} .fav img.big{image-rendering:pixelated}
.sizes{height:640px;align-items:flex-end;gap:40px;padding-bottom:44px}
"""


def page():
    lw, lh, _, _ = marks.lockup()
    y0, y1 = marks.bbox(marks.master())[1], marks.bbox(marks.master())[3]

    # 1. app icon
    icons = (
        '<div class="row">'
        f'<div class="half dark icons">{cell(f"<img src=../app-icon-1024.png width=480 height=480>", "app-icon-1024")}'
        f'{cell(f"<img src=../app-icon-1024-light.png width=240 height=240>", "light, reference")}</div>'
        '<div class="half wall icons">'
        + cell(home_icon('app-icon-1024.png', 120), '120') + cell(home_icon('app-icon-1024.png', 60), '60')
        + cell(home_icon('app-icon-1024-light.png', 120), '120 light') + cell(home_icon('app-icon-1024-light.png', 60), '60 light')
        + cell('<div class="splash"><img src=../splash-mark.png width=200 height=200></div>', 'splash-mark')
        + '</div></div>')

    # 2. lockups
    def lock(cls, tone, mc, wc):
        small = ''.join(cell(marks.lockup_svg(mc, wc, px * lh / (y1 - y0)), str(px)) for px in (32, 24))
        return (f'<div class="half {cls} lock"><img src=../lockup-{tone}.svg height=200>'
                f'<div class="small">{small}</div></div>')
    lockups = ('<div class="row">' + lock('dark', 'dark', marks.PEACH, marks.CREAM)
               + lock('cream', 'light', marks.COPPER, marks.INK) + '</div>')

    # 3. favicons, 1x and 8x
    def fav(cls, suffix):
        one = ''.join(cell(f'<img src=../favicon-{s}{suffix}.png width={s} height={s}>', str(s)) for s in (16, 32, 48))
        big = ''.join(f'<img class="big" src=../favicon-{s}{suffix}.png width={s * 8} height={s * 8}>' for s in (16, 32, 48))
        return f'<div class="half {cls} fav">{one}{big}</div>'
    favicons = '<div class="row">' + fav('tab', '-dark') + fav('white', '') + '</div>'

    # 4. the mark at 512, 120, 60, 32, 16 px high
    def sizes(cls, file):
        return (f'<div class="half {cls} sizes">'
                + ''.join(cell(f'<img src=../{file} height={h}>', str(h)) for h in (512, 120, 60, 32, 16)) + '</div>')
    marks_row = '<div class="row">' + sizes('dark', 'mark-dark.svg') + sizes('cream', 'mark.svg') + '</div>'

    return f'<style>{CSS}</style>' + icons + lockups + favicons + marks_row


if __name__ == '__main__':
    marks.shoot(page(), OUT / "proof.png", 2080, 600 + 400 + 480 + 640)
