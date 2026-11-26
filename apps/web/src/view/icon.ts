import { type Html, inertHtml as ih } from "foldkit/html"

/** Lucide icons (ISC license), drawn inline with the same attributes lucide-react set. */
type Shape = readonly ["path", string] | readonly ["circle", string, string, string]

const icon =
  (name: string, shapes: ReadonlyArray<Shape>) =>
  (className = ""): Html =>
    ih.svg(
      [
        ih.Xmlns("http://www.w3.org/2000/svg"),
        ih.Width("24"),
        ih.Height("24"),
        ih.ViewBox("0 0 24 24"),
        ih.Fill("none"),
        ih.Stroke("currentColor"),
        ih.StrokeWidth("2"),
        ih.StrokeLinecap("round"),
        ih.StrokeLinejoin("round"),
        ih.Class(["lucide", `lucide-${name}`, className].filter(Boolean).join(" ")),
        ih.AriaHidden(true),
      ],
      shapes.map((shape) =>
        shape[0] === "path"
          ? ih.path([ih.D(shape[1])])
          : ih.circle([ih.Cx(shape[1]), ih.Cy(shape[2]), ih.R(shape[3])]),
      ),
    )

const rect = (x: number, y: number, width: number, height: number, r: number): Shape => [
  "path",
  `M${x + r} ${y}h${width - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${height - 2 * r}a${r} ${r} 0 0 1-${r} ${r}h-${width - 2 * r}a${r} ${r} 0 0 1-${r}-${r}v-${height - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}z`,
]

export const settings = icon("settings", [
  [
    "path",
    "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
  ],
  ["circle", "12", "12", "3"],
])
export const arrowLeft = icon("arrow-left", [
  ["path", "m12 19-7-7 7-7"],
  ["path", "M19 12H5"],
])
export const arrowUp = icon("arrow-up", [
  ["path", "m5 12 7-7 7 7"],
  ["path", "M12 19V5"],
])
export const chevronDown = icon("chevron-down", [["path", "m6 9 6 6 6-6"]])
export const chevronRight = icon("chevron-right", [["path", "m9 18 6-6-6-6"]])
export const fileText = icon("file-text", [
  [
    "path",
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
  ],
  ["path", "M14 2v5a1 1 0 0 0 1 1h5"],
  ["path", "M10 9H8"],
  ["path", "M16 13H8"],
  ["path", "M16 17H8"],
])
export const gauge = icon("gauge", [
  ["path", "m12 14 4-4"],
  ["path", "M3.34 19a10 10 0 1 1 17.32 0"],
])
export const loaderCircle = icon("loader-circle", [["path", "M21 12a9 9 0 1 1-6.219-8.56"]])
export const paperclip = icon("paperclip", [
  [
    "path",
    "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
  ],
])
export const x = icon("x", [
  ["path", "M18 6 6 18"],
  ["path", "m6 6 12 12"],
])
export const alignLeft = icon("align-left", [
  ["path", "M21 5H3"],
  ["path", "M15 12H3"],
  ["path", "M17 19H3"],
])
export const audioLines = icon("audio-lines", [
  ["path", "M2 10v3"],
  ["path", "M6 6v11"],
  ["path", "M10 3v18"],
  ["path", "M14 8v7"],
  ["path", "M18 5v13"],
  ["path", "M22 10v3"],
])
export const link = icon("link", [
  ["path", "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"],
  ["path", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
])
export const play = icon("play", [
  ["path", "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"],
])
export const pause = icon("pause", [rect(14, 3, 5, 18, 1), rect(5, 3, 5, 18, 1)])
export const pencil = icon("pencil", [
  ["path", "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"],
  ["path", "m15 5 4 4"],
])
export const rotateCw = icon("rotate-cw", [
  ["path", "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"],
  ["path", "M21 3v5h-5"],
])
export const rotateCcw = icon("rotate-ccw", [
  ["path", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"],
  ["path", "M3 3v5h5"],
])
export const trash = icon("trash-2", [
  ["path", "M10 11v6"],
  ["path", "M14 11v6"],
  ["path", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"],
  ["path", "M3 6h18"],
  ["path", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
])
export const download = icon("download", [
  ["path", "M12 15V3"],
  ["path", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
  ["path", "m7 10 5 5 5-5"],
])
export const listMusic = icon("list-music", [
  ["path", "M16 5H3"],
  ["path", "M11 12H3"],
  ["path", "M11 19H3"],
  ["path", "M21 16V5"],
  ["circle", "18", "16", "3"],
])
export const bookOpenText = icon("book-open-text", [
  ["path", "M12 7v14"],
  ["path", "M16 12h2"],
  ["path", "M16 8h2"],
  ["path", "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"],
  ["path", "M6 12h2"],
  ["path", "M6 8h2"],
])
export const check = icon("check", [["path", "M20 6 9 17l-5-5"]])
export const copy = icon("copy", [
  rect(8, 8, 14, 14, 2),
  ["path", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
])
