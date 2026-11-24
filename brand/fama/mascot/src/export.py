"""Export the Feed cover, sleeping cutouts and proof from Blender's straight-alpha PNGs."""
import sys
from pathlib import Path
from shutil import copyfile

import numpy as np
from PIL import Image, ImageCms, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent
APPS = OUT.parents[2] / "apps"
LANCZOS = Image.Resampling.LANCZOS
BICUBIC = Image.Resampling.BICUBIC
SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
TOP = (32, 48, 43)
BOTTOM = (22, 33, 29)


def read_render(path, size):
    with Image.open(path) as image:
        assert image.mode == "RGBA" and image.size == (size, size), path
        image.load()
        return image


def feed_cover(pan):
    width, height = pan.size
    rgba = np.asarray(pan)
    ys, xs = np.nonzero(rgba[..., 3])
    assert xs.min() >= .099 * width and xs.max() < .901 * width
    assert np.hypot(xs + .5 - width / 2, ys + .5 - height / 2).max() < .45 * width

    # Composite in display space, matching the source art and the app icon.
    t = np.linspace(0, 1, height, dtype=np.float32)[:, None, None]
    ground = (1 - t) * np.array(TOP, np.float32) + t * np.array(BOTTOM, np.float32)
    alpha = rgba[..., 3:4].astype(np.float32) / 255
    rgb = rgba[..., :3] * alpha + ground * (1 - alpha)
    rng = np.random.default_rng(540)
    shape = (height, width, 1)
    noise = rng.random(shape, dtype=np.float32) - rng.random(shape, dtype=np.float32)
    rgb += noise * (1 - alpha)
    cover = Image.fromarray(np.clip(np.rint(rgb), 0, 255).astype(np.uint8))

    cover.save(OUT / "feed-cover-3000.png", optimize=True, icc_profile=SRGB)
    cover.save(OUT / "feed-cover-3000.jpg", quality=90, subsampling=0,
               optimize=True, progressive=True, icc_profile=SRGB)
    return cover


def sleeping_assets(pan):
    x0, y0, x1, y1 = pan.getchannel("A").getbbox()
    assert min(x0, y0, pan.width - x1, pan.height - y1) >= .06 * pan.width
    pan.save(OUT / "sleeping.png", optimize=True, icc_profile=SRGB)
    for size in (256, 512):
        # Premultiplied bicubic keeps the clay edges free of Lanczos ringing.
        pan.resize((size, size), BICUBIC).save(
            OUT / f"sleeping-{size}.png", optimize=True, icc_profile=SRGB
        )


def crop_shape(draw, box, shape, **style):
    if shape == "Circle":
        draw.ellipse(box, **style)
    else:
        draw.rounded_rectangle(box, radius=round((box[2] - box[0]) * .22), **style)


def proof(cover, sleeping):
    sheet = Image.new("RGB", (4312, 3200), "#191C1A")
    draw = ImageDraw.Draw(sheet)
    fonts = Path("/System/Library/Fonts/Supplemental")
    title = ImageFont.truetype(fonts / "Arial Bold.ttf", 48)
    label = ImageFont.truetype(fonts / "Arial.ttf", 36)
    circle_color = "#EABB9F"
    rounded_color = "#B9D6C4"

    def caption(x, y, value, font=label, color="#FBF3E9"):
        draw.text((x, y), value, font=font, fill=color, anchor="lt")

    left, right, top = 64, 3128, 136
    caption(left, 64, "Feed cover  /  3000 px", title)
    sheet.paste(cover, (left, top))
    caption(right, 64, "Feed cover  /  Thumbnails", title)

    sheet.paste(cover.resize((600, 600), LANCZOS), (right, top))
    guide_box = (right + 2, top + 2, right + 597, top + 597)
    crop_shape(draw, guide_box, "Circle", outline=circle_color, width=3)
    crop_shape(draw, guide_box, "Rounded", outline=rounded_color, width=3)
    caption(right, top + 624, "600 px")
    caption(right + 164, top + 624, "Circle", color=circle_color)
    caption(right + 324, top + 624, "Rounded", color=rounded_color)

    for x, y, size in ((right + 664, top, 300), (right + 664, top + 420, 60)):
        sheet.paste(cover.resize((size, size), LANCZOS), (x, y))
        caption(x, y + size + 24, f"{size} px")

    y = 920
    for x, shape in ((right, "Circle"), (right + 552, "Rounded")):
        mask = Image.new("L", (1200, 1200))
        crop_shape(ImageDraw.Draw(mask), (0, 0, 1199, 1199), shape, fill=255)
        sheet.paste(cover.resize((300, 300), LANCZOS), (x, y), mask.resize((300, 300), LANCZOS))
        caption(x, y + 324, f"{shape}  /  300 px")

    draw.line((right, 1440, right + 1064, 1440), fill="#454F48", width=2)
    caption(right, 1536, "Sleeping  /  Dark and light", title)
    for x, ground in ((right, "#0A0A0A"), (right + 552, "#FAFAFA")):
        caption(x, 1624, ground)
        for dx, y, size in ((0, 1688, 512), (0, 2312, 160), (224, 2312, 96)):
            avatar = sleeping.resize((size, size), BICUBIC)
            tile = Image.new("RGB", (size, size), ground)
            tile.paste(avatar, (0, 0), avatar.getchannel("A"))
            sheet.paste(tile, (x + dx, y))
            caption(x + dx, y + size + 24, f"{size} px")

    sheet.convert("RGB").save(OUT / "proof.jpg", quality=85, icc_profile=SRGB)


if __name__ == "__main__":
    renders = Path(sys.argv[1])
    cover = feed_cover(read_render(renders / "open.png", 3000))
    sleeping = read_render(renders / "wrapped.png", 1024)
    sleeping_assets(sleeping)
    proof(cover, sleeping)
    cover.resize((1400, 1400), LANCZOS).save(
        APPS / "api/src/cover.jpg", quality=88, subsampling=0,
        optimize=True, progressive=True, icc_profile=SRGB,
    )
    for path in ("web/public/pan-sleeping.png", "mobile/assets/pan-sleeping.png"):
        copyfile(OUT / "sleeping-512.png", APPS / path)
