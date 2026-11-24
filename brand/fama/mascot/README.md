# Fama mascots

## Ribbon + Fan

One clay surface forms the ear hollow, rim, and feather tips. Pan wears a sage beret. His companion has short plum curls.

| Character | Transparent 512 × 512 PNGs |
| --- | --- |
| Pan | [Open](ribbon-fan/pan/open.png), [folded](ribbon-fan/pan/folded.png), [listening](ribbon-fan/pan/listening.png), [speaking](ribbon-fan/pan/speaking.png), [waving](ribbon-fan/pan/waving.png) |
| Companion | [Open](ribbon-fan/companion/open.png), [listening](ribbon-fan/companion/listening.png) |

Rebuild with Blender 5.2 from `brand/fama/mascot`.

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
  --python-exit-code 1 --python src/poses.py -- ribbon-fan/pan
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
  --python-exit-code 1 --python src/companion.py -- ribbon-fan/companion
```

## Feed cover and sleeping pose

The Feed cover and empty-state art use the Take B Fold model.

| File | Dimensions | Size | Use |
| --- | --- | --- | --- |
| `feed-cover-3000.png` | 3000 × 3000 | 5.24 MB | Lossless RGB cover master. Not committed (git-ignored); the rebuild makes it. |
| [feed-cover-3000.jpg](feed-cover-3000.jpg) | 3000 × 3000 | 329 KB | RGB Feed cover for the 512 KB budget |
| [sleeping.png](sleeping.png) | 1024 × 1024 | 538 KB | Transparent master |
| [sleeping-512.png](sleeping-512.png) | 512 × 512 | 142 KB | Transparent empty-state asset up to about 170 logical px at 3× |
| [sleeping-256.png](sleeping-256.png) | 256 × 256 | 46 KB | Transparent empty-state asset up to 128 logical px at 2× |
| [proof.jpg](proof.jpg) | 4312 × 3200 | JPEG | Cover crops and dark and light empty-state previews |

## Use

- Both cover formats are opaque sRGB. The ground grades from `#20302B` to `#16211D`. Triangular dither of up to one 8-bit level keeps the PNG gradient smooth. The JPEG uses quality 90 with full chroma resolution.
- Pan spans about 80% of the cover width. Keep the whole square when you hand it to a podcast app. The proof shows the cover at 3000, 600, 300 and 60 px, with circle and rounded rectangle crops.
- The sleeping files use straight alpha. Place them directly on `#0A0A0A` or `#FAFAFA`. Warm rim light defines the clay edge. The files have no ground shadow. The proof shows both grounds at 512, 160 and 96 px.

## Rebuild

Use Blender 5.2 and `uv` on macOS. The proof uses the system Arial fonts. Run from `brand/fama/mascot`.

```sh
(
  set -e
  render_dir=$(mktemp -d .render.XXXXXX)
  trap 'rm -r "$render_dir"' EXIT
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
    --python-exit-code 1 --python src/studio.py -- "$render_dir"
  uv run --no-project --with pillow --with numpy python src/export.py "$render_dir"
)
```

[src/studio.py](src/studio.py) renders the Feed cover and sleeping pose from the Take B model. [src/export.py](src/export.py) adds the spruce ground, makes the smaller sleeping files and builds the proof. The original studies are kept outside the repo.

## In the apps

- `apps/api/src/cover.jpg`: the feed cover at 1400 × 1400, JPEG quality 88, served at `/feed/<token>/cover.jpg`. A PNG is about 1.4 MB because of the dither, too large to bundle in the Worker.
- `apps/web/public/pan-sleeping.png` and `apps/mobile/assets/pan-sleeping.png`: `sleeping-512.png`, shown at 160 px in the empty library.
