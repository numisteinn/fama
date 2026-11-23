"""Fama app icons from the 3D render.

Run from brand/fama (after studio.py, which writes src/metal.png):
  uv run --no-project --with pillow --with numpy python src/icons.py

Writes app-icon-1024.png (dark, the app icon), app-icon-1024-light.png (reference only),
icon-512.png (apple-touch-icon) and splash-mark.png (the 3D mark alone, transparent).
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter, ImageStat

SRC = Path(__file__).resolve().parent
OUT = SRC.parent
LANCZOS = Image.Resampling.LANCZOS
#          ground top       ground bottom    shadow colour   strength  blur
DARK = ((32, 48, 43),    (22, 33, 29),    (6, 9, 8),      0.45,     10)   # deep spruce, #20302B to #16211D
LIGHT = ((236, 214, 208), (222, 197, 190), (120, 72, 58),  0.34,     7)    # blush, #ECD6D0 to #DEC5BE
CLEAR = 118              # smallest clear space in the 1024 icon, shadow included


def ground(top, bottom):
    """Vertical gradient in float, 0..255. No 8-bit steps yet."""
    t = np.linspace(0, 1, 1024)[:, None, None]
    g = np.array(top, float) * (1 - t) + np.array(bottom, float) * t
    return np.broadcast_to(g, (1024, 1024, 3)).copy()


def to_8bit(px, seed=540):
    """Triangular dither (+-1 LSB, sigma 0.41) before the cast, so the gradient does not band."""
    rng = np.random.default_rng(seed)
    noise = rng.random(px.shape) - rng.random(px.shape)
    return Image.fromarray(np.clip(np.round(px + noise), 0, 255).astype(np.uint8), 'RGB')


def shrink(im, size):
    """Downscale in float and dither again. A plain 8-bit resize averages the dither away."""
    px = np.stack([np.asarray(c.convert('F').resize((size, size), LANCZOS)) for c in im.split()], -1)
    return to_8bit(px, seed=size)


def place(metal):
    """Optical centre: 30% of the way from the box centre to the centre of mass."""
    alpha = metal.getchannel('A')
    box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    small = alpha.resize((256, 256), LANCZOS)
    px = small.load()
    mass = sum(px[x, y] for x in range(256) for y in range(256))
    mx = sum(px[x, y] * (x + .5) for x in range(256) for y in range(256)) / mass * 4
    my = sum(px[x, y] * (y + .5) for x in range(256) for y in range(256)) / mass * 4
    dx = round(512 - (0.7 * (box[0] + box[2]) / 2 + 0.3 * mx))
    dy = round(512 - (0.7 * (box[1] + box[3]) / 2 + 0.3 * my))
    placed = Image.new('RGBA', metal.size)
    placed.paste(metal, (dx, dy))
    return placed, (dx, dy)


def icon(placed, tone):
    top, bottom, shade, strength, blur = tone
    alpha = placed.getchannel('A')
    shadow = Image.new('L', placed.size)
    shadow.paste(alpha, (3, 9))
    shadow = np.asarray(shadow.filter(ImageFilter.GaussianBlur(blur)), float)[..., None] / 255 * strength
    g = ground(top, bottom)
    px = g * (1 - shadow) + np.array(shade, float) * shadow          # ground + shadow, still float
    im = to_8bit(px)
    im.paste(placed, (0, 0), alpha)
    # clear space: to the first pixel where the shadow or the mark changes the ground by more than one level
    changed = (np.abs(px - g).max(-1) > 1) | (np.asarray(alpha) > 8)
    ys, xs = np.nonzero(changed)
    return im, int(min(xs.min(), ys.min(), 1023 - xs.max(), 1023 - ys.max()))


def contrast(a, b):
    """WCAG contrast ratio of two sRGB colours (0..255)."""
    def lum(c):
        lin = [((v / 255 + .055) / 1.055) ** 2.4 if v / 255 > .04045 else v / 255 / 12.92 for v in c]
        return .2126 * lin[0] + .7152 * lin[1] + .0722 * lin[2]
    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + .05) / (lo + .05)


def main():
    metal = Image.open(SRC / 'metal.png').convert('RGBA')
    placed, shift = place(metal)
    dark, clear_dark = icon(placed, DARK)
    light, clear_light = icon(placed, LIGHT)
    assert dark.mode == 'RGB' and min(clear_dark, clear_light) >= CLEAR, (clear_dark, clear_light)
    dark.save(OUT / 'app-icon-1024.png')
    light.save(OUT / 'app-icon-1024-light.png')
    shrink(dark, 512).save(OUT / 'icon-512.png')

    # splash: the mark alone, 480 px on its long side, centred in 512, no shadow
    box = metal.getchannel('A').point(lambda v: 255 if v > 0 else 0).getbbox()
    crop = metal.crop(box)
    k = 480 / max(crop.size)
    size = (round(crop.width * k), round(crop.height * k))
    pre = crop.convert('RGBa').resize(size, LANCZOS).convert('RGBA')      # premultiplied: no dark fringe
    splash = Image.new('RGBA', (512, 512))
    splash.paste(pre, ((512 - size[0]) // 2, (512 - size[1]) // 2))
    splash.save(OUT / 'splash-mark.png')

    solid = placed.getchannel('A').point(lambda v: 255 if v == 255 else 0)
    median = ImageStat.Stat(placed.convert('RGB'), solid).median
    # the ground is lightest at the top, so the top row of the mark is the worst case for contrast
    y_top = placed.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()[1]
    at = lambda t: tuple(a + (b - a) * t for a, b in zip(DARK[0], DARK[1]))
    ratios = {name: round(contrast(median, at(t)), 2)
              for name, t in (('mark top', y_top / 1023), ('middle', 0.5), ('bottom', 1.0))}
    assert ratios['mark top'] >= 4.5, ratios
    print('median copper #%02X%02X%02X' % tuple(median), 'contrast with the dark ground', ratios,
          'shift', shift, 'clear dark', clear_dark, 'clear light', clear_light)


if __name__ == '__main__':
    main()
