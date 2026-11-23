# Fama brand kit

The logo is Contour: an ear made of three sound waves. Dark mode is primary. Open `proof.png` first.

## Files

| File | Use |
| --- | --- |
| `mark.svg` | The mark in copper `#935841`. For light grounds. |
| `mark-dark.svg` | The mark in peach `#EABB9F`. For dark grounds. This is the default. |
| `mark-mono.svg` | The mark in `currentColor`. Put it inline in the page. In an `<img>` it is black. |
| `lockup-dark.svg` | Peach mark + cream "fama". Transparent. For dark grounds. |
| `lockup-light.svg` | Copper mark + spruce "fama". Transparent. For light grounds. |
| `lockup-dark.png`, `lockup-light.png` | 1600 × 640 previews on black and on cream. The ground is part of the image. |
| `favicon.svg` | The 32 px drawing. Copper, and peach when `prefers-color-scheme` is dark. |
| `favicon-16.png`, `favicon-32.png`, `favicon-48.png` | Copper, transparent. Each size is a separate drawing with its flat edges snapped to the grid. |
| `favicon-16-dark.png`, `favicon-32-dark.png`, `favicon-48-dark.png` | The same drawings in peach. |
| `app-icon-1024.png` | The iOS app icon. Opaque RGB, square corners. Brushed rose-copper on deep spruce. |
| `app-icon-1024-light.png` | Copper on blush. Reference only. Do not ship it. |
| `icon-512.png` | `apple-touch-icon` for the web app. The dark icon at 512 px. |
| `splash-mark.png` | The 3D mark alone, transparent, 512 × 512. For the Expo splash on `#0B0B0C`. |
| `proof.png` | All of the above on one sheet. |
| `header-proof.png` | The lockup at 24 px and 32 px mark height, at 1x and 2x. |
| `src/` | The scripts and their inputs. See "Rebuild". |

Favicon links for the web app:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32-dark.png" sizes="32x32" type="image/png" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon-16-dark.png" sizes="16x16" type="image/png" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png" media="(prefers-color-scheme: light)">
<link rel="apple-touch-icon" href="/icon-512.png">
```

- Some browsers ignore `media` on icon links. When two icons of the same size match, many browsers use the last one, so those browsers show the copper PNG on all themes.
- In Chrome, the colour switch in `favicon.svg` follows the theme of the operating system, not the theme of the browser.
- All SVG files have `width` and `height` attributes: the marks 700 × 773, the lockups 2859 × 820, `favicon.svg` 32 × 32. The lockups have a `<title>`.

## The mark

Three bands that are parallel curves of one ear outline. It is a left ear and the face is to the left.

- The outer band is the helix. It goes over the crown, down the back and turns into the lobe.
- The middle band is the antihelix. It stops above the lobe.
- The inner band is the concha. It curls toward the ear canal.
- Each band turns in one direction only. Thus no band can read as a "?".

Parameters, in the units of `mark.svg` (viewBox `0 0 700 773`):

| Parameter | Value |
| --- | --- |
| Crown centre | (350, 350) |
| Crown radii (centreline) | helix 300, antihelix 188, concha 76 |
| Stroke | 58, round ends |
| Gap | 54, the same between all bands |
| Band step | 112 (stroke + gap) |
| Start angle | 205° before the tilt (0° = right, counter-clockwise) |
| Tilt | 12° clockwise. The three front ends are on one line through the crown centre, 13° below the horizontal. |
| Helix | R 300 for 225°, then R 560 for 28°, R 190 for 62°, R 88 for 100° (the lobe) |
| Antihelix | R 188 for 225°, then R 448 for 28°, R 78 for 31° |
| Concha | R 76 for 250° |
| Mark box | 658 × 730.65 |
| Margin in the viewBox | 21 on all sides |

The paths are stroked centrelines. They hold only `M` and `A` commands and no transforms. The arc radii in the file are the numbers in this table.

## Lockup

The mark, then "fama" in Fraunces, outlined. No font file is necessary.

- Font: Fraunces, wght 540, opsz 72, SOFT 100, WONK 1.
- Mark stroke = 0.55 × the stem of "m".
- The x-height is centred on the mark. The x-height is 0.57 × the mark height. The lobe hangs below the baseline.
- Space from the mark to the "f" = 240 units = 0.33 × the mark height.
- viewBox `0 0 2859 820`, margin 21 on all sides. The lockup file is 1.12 × as high as its mark. For a 24 px mark, set the lockup to 27 px high. For a 32 px mark, set it to 36 px.

## Favicons

Each size is a separate drawing with its flat edges snapped to the grid. It is not a scaled master.

| Size | Bands | Stroke | Gap | Crown centre | Crown radii | Front cut rows (helix first) | Drawing box |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | 2 | 2 px | 2 px | (8, 7) | 6, 2 | 9, 8 | 14 × 16 |
| 32 | 3 | 3 px | 2 px | (16, 15) | 12.5, 7.5, 2.5 | 18, 17, 16 | 28 × 30 |
| 48 | 3 | 4 px | 3 px | (24, 22) | 19, 12, 5 | 27, 26, 24 | 42 × 46 |

- The crown centre is on a pixel corner. The top, left and right edges of each band are on pixel edges.
- Each front end is cut flat on a pixel row. The rows step down from the concha to the helix. Thus the ends follow the 13° line of the master.
- The back and lobe radii are solved so that the bottom and the left edge of the lobe are on pixel edges.
- The curves and the back are antialiased. Only the flat edges are on the grid.
- The ends are flat cuts, as on the 3D icon. The strokes are heavier than the master, because thin strokes go grey at these sizes.
- `favicon.svg` is sharp at 32 px and 64 px. At 16 px on a 1x screen it is soft. `favicon-16.png` is for that case.

## App icon

- 1024 × 1024, opaque RGB, square corners. iOS adds the mask.
- Ground: deep spruce, `#20302B` at the top to `#16211D` at the bottom. It is light enough to show the edge of the tile on a black ground. Against the app background `#0A0A0A` it is 1.43 : 1 at the top and 1.20 : 1 at the bottom (against pure `#000000`: 1.5 : 1 and 1.3 : 1). The bottom edge is faint; the copper contrast limits how far the ground can lift.
- The ground and the shadow are made in float. Triangular dither (±1 LSB) is added before the 8-bit cast, so the gradient has no bands. `icon-512.png` is scaled in float and dithered again.
- Bands: the flat centrelines, swept with a soft-oval section. Band width 57.5 px, gap 53.5 px, depth 0.66 × width.
- Ends: flat cuts with a 3.4 px chamfer. The cut and the chamfer are real geometry with sharp edges, so the shading of the band stays clean up to the end.
- Copper: base `#DFA791`, metallic 0.9, anisotropy 0.6 along the band, roughness 0.38 to 0.45 from noise stretched along the band, a light bump. A salmon light `#E08A68` from below warms the lower edges.
- Median rendered copper: `#B88672`. Contrast with the ground: 4.5 : 1 against the ground at the top edge of the mark (y = 161; against the `#20302B` top swatch it is 4.4 : 1), 4.8 : 1 in the middle, 5.3 : 1 at the bottom.
- Camera: orthographic, 4° to the left and 5° above, so the cut ends show.
- Position: optical centre, 6 px left and 10 px down from the box centre.
- Clear space with the shadow: 118 px (dark), 118 px (light).

## Colour

| Name | Hex | Role |
| --- | --- | --- |
| Copper | `#935841` | The flat mark and accents on light grounds. 5.1 : 1 on cream. |
| Peach | `#EABB9F` | The flat mark and accents on dark grounds. 11.4 : 1 on black. |
| Spruce ground | `#20302B` to `#16211D` | The ground of the app icon. Use it only there. |
| Spruce ink | `#284C44` | The wordmark and text on light grounds. 8.7 : 1 on cream. |
| Blush | `#ECD6D0` to `#DEC5BE` | The ground of the light icon. Reference only. |
| Cream | `#FBF3E9` | The wordmark and text on dark grounds. The page ground in light mode. |
| Black | `#0A0A0A` | The page ground in dark mode. This is the default. The Expo splash uses `#0B0B0C`. |

The 3D copper (`#B88672`) is a render, not a UI colour. Use peach or copper for flat work.

## Type

- Wordmark: Fraunces, wght 540. Always use the outlined lockup. Do not set the wordmark in live text.
- UI (suggestion): Figtree. 400 for text, 500 for labels, 600 for titles.

## Clear space and minimum size

- Clear space: one band step (stroke + gap) on all sides of the mark or the lockup. This is 112 units, or 0.15 × the mark height. The 21 unit margin in the files is not clear space.
- Minimum size of the mark on a screen: 24 px high. Below 24 px, use the favicon drawings.
- Minimum size of the lockup on a screen: 24 px mark height (27 px file height).
- Minimum size in print: mark 8 mm high.
- App icon: keep 118 / 1024 clear on all sides, shadow included.

## Do

- Use peach on dark grounds and copper on light grounds.
- Use the 3D mark only on the app icon and the splash.
- Keep the stroke and the gap almost equal.
- Keep the 12° tilt.

## Do not

- Do not add a dot, a tail or a second curve that makes a band read as a "?".
- Do not add feather tips or pointed ends. The flat mark has round ends. The 3D mark has flat cuts.
- Do not put a gradient, a shadow or a texture on the flat mark.
- Do not change the number of bands, except in the 16 px favicon.
- Do not mirror or turn the mark.
- Do not put the peach mark on cream or the copper mark on black. The contrast is too low.
- Do not put the flat mark on the spruce icon ground.

## Rebuild

Run these commands from `brand/fama`. They need Google Chrome, Blender and `uv`.

```sh
uv run --no-project --with pillow --with numpy python src/marks.py   # SVGs, lockups, favicons, header-proof.png, src/paths.json
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 -P src/studio.py   # src/metal.png
uv run --no-project --with pillow --with numpy python src/icons.py   # app icons, icon-512.png, splash-mark.png
uv run --no-project --with pillow --with numpy python src/proof.py   # proof.png
```

- `src/marks.py`: the parametric source of all flat work. To change the ear, edit `HELIX`, `R`, `S`, `D`, `A0` and `TILT`. To change a favicon, edit the `FAVICON` table.
- `src/studio.py`: the Blender scene (bands, copper, lights, camera).
- `src/icons.py`: ground, dither, shadow, optical centre and exports. It stops if the clear space is less than 118 px or if the copper contrast at the top of the mark is less than 4.5 : 1.
- `src/proof.py`: the proof sheet.
- `src/fraunces-540.json`: the outlines of "fama".
- `src/paths.json`, `src/metal.png`: build outputs that the subsequent steps read.

## Known limits

- The light app icon uses the same render as the dark icon. It is not tuned for blush.
- There is no 180 × 180 `apple-touch-icon`. `icon-512.png` is used and iOS scales it.
- There are no Android adaptive icon layers and no `.ico` file.
- Nothing in `apps/` uses these files yet.
