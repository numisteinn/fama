"""Render Pan's gesture studies with Ribbon + Fan ears."""
from pathlib import Path
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ribbon_fan import make_wing
from studio import HEAD_S, HEAD_Z, bean, head, materials, render_scene, wing_path


# Control points in ear-local coordinates, from attachment to tip.
# A positive x moves out from the head on both sides.
ROOT = (.80, .02, -.14)
POSES = {
    "listening": {
        "tilt": 8,
        "left": (True, [ROOT, (1.16, .04, -.34), (1.39, .02, -.52), (1.22, -.08, -.72)]),
        "right": (False, [ROOT, (1.82, .16, -.50), (2.38, -.29, .79), (1.08, -.63, 1.06)]),
    },
    "speaking": {
        "tilt": -5,
        "left": (False, [ROOT, (1.23, .05, .08), (1.49, .07, .75), (1.61, .02, 1.47)]),
        "right": (False, [ROOT, (1.43, -.10, -.25), (2.11, -.16, -.11), (2.38, -.22, .45)]),
    },
    "waving": {
        "tilt": -6,
        "left": (True, [ROOT, (1.15, .05, -.24), (1.45, .09, -.70), (1.34, -.03, -1.00)]),
        "right": (False, [ROOT, (1.49, .04, -.09), (1.86, -.10, .92), (1.79, -.22, 1.76)]),
    },
}


def render_pose(name, output):
    pose = POSES[name]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    clay = materials()
    head(clay)
    if name == "speaking":
        for obj in list(bpy.context.scene.objects):
            if obj.name.startswith("Smile"):
                bpy.data.objects.remove(obj, do_unlink=True)
        bean("Open mouth", (0, -.528 * HEAD_S, HEAD_Z - .263 * HEAD_S),
             (.105 * HEAD_S, .035 * HEAD_S, .094 * HEAD_S), clay["ink"])
        bean("Lower lip", (0, -.558 * HEAD_S, HEAD_Z - .308 * HEAD_S),
             (.057 * HEAD_S, .011 * HEAD_S, .029 * HEAD_S), clay["cheek"])

    for side, direction in ((-1, "left"), (1, "right")):
        folded, points = pose[direction]
        make_wing(points, side, clay, folded=folded)
    render_scene(output / f"{name}.png", 512, .84, tilt=pose["tilt"], rim_strength=.7)


def render_open_or_folded(path, *, folded, resolution=512, fill=.84):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    clay = materials()
    head(clay, closed_eyes=folded)
    pose = "wrapped" if folded else "open"
    for side in (-1, 1):
        make_wing(wing_path(pose, side), side, clay, folded=folded)
    render_scene(path, resolution, fill, tilt=-7 if folded else 0, rim_strength=.65)


if __name__ == "__main__":
    output, *names = sys.argv[sys.argv.index("--") + 1:]
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if names == ["--app-art"]:
        render_open_or_folded(output / "open.png", folded=False, resolution=3000, fill=.80)
        render_open_or_folded(output / "wrapped.png", folded=True, resolution=1024, fill=.86)
    else:
        if not names:
            render_open_or_folded(output / "open.png", folded=False)
            render_open_or_folded(output / "folded.png", folded=True)
        for name in names or POSES:
            render_pose(name, output)
