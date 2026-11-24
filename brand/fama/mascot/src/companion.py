"""Render Pippa with short plum curls and Ribbon + Fan ears."""
import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import studio
from ribbon_fan import make_wing


OPEN = (
    ((.79, .02, -.14), (1.33, -.02, -.13), (1.89, .03, .34), (2.10, .12, 1.04)),
    ((.79, .02, -.14), (1.34, .01, -.11), (1.85, .08, .45), (1.96, .10, 1.17)),
)
LISTENING = (
    ((.79, .02, -.14), (1.43, .02, -.12), (1.83, .06, .65), (1.20, -.29, 1.36)),
    ((.79, .02, -.14), (1.31, -.07, -.18), (1.63, -.27, -.62), (1.85, -.48, -.82)),
)


def hair(material):
    # The crown follows the head. The edge rises across the forehead and drops at the nape.
    s, z = studio.HEAD_S, studio.HEAD_Z
    around, down = 96, 24
    verts = [(0, 0, z + .80 * s)]
    for row in range(1, down + 1):
        u = row / down
        for col in range(around):
            az = math.tau * col / around
            front = math.cos(az)
            edge = -.19 + .71 * max(front, 0) ** 1.2
            edge += .105 * math.sin(az) * max(front, 0) ** .75
            angle = u * math.acos(edge / .73)
            x = .694 * math.sin(angle) * math.sin(az)
            y = -.568 * math.sin(angle) * front
            crown = .07 * math.cos(angle) ** 2
            height = .73 * math.cos(angle) + crown
            verts.append((x * s, y * s, z + height * s))
    faces = []
    for col in range(around):
        other = (col + 1) % around
        faces.append((0, col + 1, other + 1))
        for row in range(down - 1):
            start = 1 + row * around
            faces.append((start + col, start + around + col, start + around + other, start + other))
    faces.append(tuple(1 + (down - 1) * around + col for col in range(around)))
    mesh = bpy.data.meshes.new("Hair crown")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.collection.objects.link(obj)
    studio.finish(obj, material)
    curls = []
    for x, y, height, radius in (
        (-.55, -.21, .53, .24), (-.39, -.35, .68, .24), (-.15, -.35, .77, .23),
        (.10, -.29, .77, .22), (.33, -.25, .71, .22), (.51, -.21, .54, .23),
        (-.27, .03, .79, .25), (.09, .08, .83, .26), (.37, .06, .69, .23),
    ):
        curls.append(studio.bean("Curl", (x * s, y * s, z + height * s),
                                 tuple(radius * k * s for k in (1, .95, 1.02)), material))
    bpy.ops.object.select_all(action="DESELECT")
    for curl in curls:
        curl.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
    # Fuse the hair pieces with the crown.
    obj.data.remesh_voxel_size = .012
    bpy.ops.object.voxel_remesh()
    smooth = obj.modifiers.new("Smooth the join", "SMOOTH")
    smooth.factor = 1
    smooth.iterations = 8
    for face in obj.data.polygons:
        face.use_smooth = True


def head(materials, listening):
    s, z = studio.HEAD_S, studio.HEAD_Z
    skin = studio.mat("Apricot clay", "C77D5C")
    cheek = studio.mat("Rose clay", "C46E64")
    chestnut = studio.mat("Chestnut clay", "634039", rough=.67)
    ink = materials["ink"]
    studio.bean("Head", (0, 0, z), (.69 * s, .55 * s, .71 * s), skin)
    for side in (-1, 1):
        x = side * .255
        gaze = .027 if listening else 0
        studio.bean("Eye", ((x + gaze) * s, -.505 * s, z + .03 * s),
                    (.056 * s, .034 * s, .071 * s), ink, (0, side * .16, 0))
        studio.line("Brow", [((x + side * dx) * s, depth * s, z + height * s)
                             for dx, depth, height in ((-.053, -.518, .166),
                                                       (0, -.502, .192),
                                                       (.066, -.475, .175))],
                    .015 * s, chestnut)
        studio.bean("Cheek", (side * .421 * s, -.435 * s, z - .115 * s),
                    (.097 * s, .032 * s, .055 * s), cheek, (0, side * -.15, 0))
    studio.bean("Nose", (0, -.55 * s, z - .085 * s), (.092 * s, .09 * s, .07 * s), skin)
    smile = [(-.080, -.231), (.018, -.264), (.126, -.222)]
    studio.line("Smile", [(x * s, -.514 * s, z + height * s) for x, height in smile],
                .020 * s, ink)
    hair(studio.mat("Plum clay", "59394F", rough=.67))


if __name__ == "__main__":
    output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    for name, pair, tilt in (("open", OPEN, 0), ("listening", LISTENING, 8)):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        materials = studio.materials()
        listening = name == "listening"
        head(materials, listening)
        for points, side in zip(pair, (1, -1), strict=True):
            make_wing(points, side, materials, folded=listening and side == -1)
        studio.render_scene(output / f"{name}.png", 512, .84, tilt=tilt, rim_strength=.65)
