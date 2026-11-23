"""Fama 3D mark: brushed rose-copper bands swept along the flat mark.

Run from brand/fama (after marks.py, which writes src/paths.json):
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 -P src/studio.py

Writes src/metal.png (1024, transparent). icons.py adds the ground and exports the icons.
1024 px = 4 Blender units. The mark lies in the XZ plane and faces -Y.
"""
import json
from math import cos, sin, pi, radians, copysign
from pathlib import Path
import bpy
from mathutils import Vector

SRC = Path(__file__).resolve().parent
PX = 256.0            # pixels per Blender unit
DEPTH = 0.66          # band depth / band width
SQUARE = 2.5          # superellipse exponent of the cross-section (2 = oval)
SIDES = 64
CHAMFER = 0.014      # 3.6 px at the cut ends
SAMPLES = 128
WORLD = 0.9          # strength of the reflected studio gradient


def lin(h):
    def f(v):
        x = int(v, 16) / 255
        return ((x + .055) / 1.055) ** 2.4 if x > .04045 else x / 12.92
    return (*[f(h[i:i + 2]) for i in (0, 2, 4)], 1)


BASE = 'DFA791'


def copper_end():
    """The cut and its chamfer: the same copper with no grain direction."""
    m = bpy.data.materials.new('Copper cut')
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = lin(BASE)
    p.inputs['Metallic'].default_value = 0.9
    p.inputs['Roughness'].default_value = 0.42
    return m


def copper():
    m = bpy.data.materials.new('Brushed rose copper')
    m.use_nodes = True
    t = m.node_tree
    p = t.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = lin(BASE)
    p.inputs['Metallic'].default_value = 0.9
    p.inputs['Anisotropic'].default_value = 0.6
    # brushed grain: noise stretched along the band (u runs along the band)
    uv = t.nodes.new('ShaderNodeTexCoord')
    stretch = t.nodes.new('ShaderNodeVectorMath')
    stretch.operation = 'MULTIPLY'
    stretch.inputs[1].default_value = (2.2, 210, 1)
    t.links.new(uv.outputs['UV'], stretch.inputs[0])
    noise = t.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 1
    noise.inputs['Detail'].default_value = 3
    t.links.new(stretch.outputs[0], noise.inputs['Vector'])
    rough = t.nodes.new('ShaderNodeMapRange')
    rough.inputs['To Min'].default_value = 0.38
    rough.inputs['To Max'].default_value = 0.45
    t.links.new(noise.outputs['Fac'], rough.inputs[0])
    t.links.new(rough.outputs[0], p.inputs['Roughness'])
    bump = t.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.3
    bump.inputs['Distance'].default_value = 0.002
    t.links.new(noise.outputs['Fac'], bump.inputs['Height'])
    t.links.new(bump.outputs[0], p.inputs['Normal'])
    tan = t.nodes.new('ShaderNodeTangent')
    tan.direction_type = 'UV_MAP'
    t.links.new(tan.outputs[0], p.inputs['Tangent'])
    return m


def band(points, width, mats, name):
    """Sweep the section along the centreline. Each end is a flat cut with a chamfer.

    The chamfer and the cut are real geometry with sharp edges, so the side normals stay
    radial up to the end (a bevel modifier bends them and leaves a dark ring near the cut).
    """
    pts = [Vector(((x - 512) / PX, (512 - y) / PX)) for x, y in points]
    a, b = width / 2 / PX, width / 2 / PX * DEPTH
    n = len(pts)
    length = [0.0]
    for i in range(1, n):
        length.append(length[-1] + (pts[i] - pts[i - 1]).length)
    tg0 = (pts[1] - pts[0]).normalized()
    tg1 = (pts[-1] - pts[-2]).normalized()
    # rows: chamfer ring, n section rings, chamfer ring
    rows = ([(pts[0] - tg0 * CHAMFER, tg0, CHAMFER, length[0] - CHAMFER)]
            + [(p, (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized(), 0.0, length[i]) for i, p in enumerate(pts)]
            + [(pts[-1] + tg1 * CHAMFER, tg1, CHAMFER, length[-1] + CHAMFER)])
    verts, faces, u = [], [], []
    for p, tg, inset, along in rows:
        nx, nz = -tg.y, tg.x                     # in-plane normal
        u.append(along)
        for s in range(SIDES):
            ang = 2 * pi * s / SIDES
            c, d = cos(ang), sin(ang)
            w = (a - inset) * copysign(abs(c) ** (2 / SQUARE), c)
            y = (b - inset) * copysign(abs(d) ** (2 / SQUARE), d)
            verts.append((p.x + nx * w, -y, p.y + nz * w))
    m = len(rows)
    for i in range(m - 1):
        for s in range(SIDES):
            q, r = i * SIDES + s, i * SIDES + (s + 1) % SIDES
            faces.append((q, q + SIDES, r + SIDES, r))
    sides = len(faces)
    faces += [tuple(range(SIDES)), tuple(reversed(range(len(verts) - SIDES, len(verts))))]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for mat in mats:
        mesh.materials.append(mat)
    uvl = mesh.uv_layers.new()
    for f in mesh.polygons:
        f.use_smooth = True
        row = f.index // SIDES
        f.material_index = 1 if f.index >= sides or row in (0, m - 2) else 0   # cut and chamfer: no grain
        for k, li in enumerate(f.loop_indices):
            r, s = divmod(mesh.loops[li].vertex_index, SIDES)
            wrap = s == 0 and k in (2, 3) and f.index < sides
            uvl.data[li].uv = (u[r], (s + SIDES * wrap) / SIDES)
    sharp = mesh.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
    for e in mesh.edges:
        r0, r1 = e.vertices[0] // SIDES, e.vertices[1] // SIDES
        sharp.data[e.index].value = r0 == r1 and r0 in (0, 1, m - 2, m - 1)
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    return o


def aim(o, target=(0, 0, 0)):
    o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()


def light(loc, power, size, tint, target=(0, 0, 0)):
    bpy.ops.object.light_add(type='AREA', location=loc)
    o = bpy.context.object
    o.data.energy = power
    o.data.shape = 'DISK'
    o.data.size = size
    o.data.color = lin(tint)[:3]
    aim(o, target)


bpy.ops.wm.read_factory_settings(use_empty=True)
mats = [copper(), copper_end()]
bands = json.loads((SRC / 'paths.json').read_text())
for j, bnd in enumerate(bands):
    band(bnd['points'], bnd['w'], mats, ['Helix', 'Antihelix', 'Concha'][j])

bpy.ops.object.camera_add(location=(-0.62, -9, 0.8))
cam = bpy.context.object
aim(cam)
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 4.24        # the mark keeps 118 px clear with its shadow
light((-3.4, -5, 5.6), 720, 3.0, 'FFF8F2')        # key, top left
light((3.8, -3.2, 2.8), 160, 4, 'FFF4EC')         # fill, right
light((-0.8, -0.5, 6), 380, 2.4, 'FFF6EC')          # top rim
light((1.2, -0.6, -3.4), 230, 3, 'E08A68')        # warm salmon from below
sc = bpy.context.scene
sc.camera = cam
sc.world = bpy.data.worlds.new('Warm studio')
sc.world.use_nodes = True
wt = sc.world.node_tree
bg = wt.nodes['Background']
# a soft vertical gradient for the copper to reflect: light above, dark warm below
co = wt.nodes.new('ShaderNodeTexCoord')
sep = wt.nodes.new('ShaderNodeSeparateXYZ')
wt.links.new(co.outputs['Generated'], sep.inputs[0])
ramp = wt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].position = 0.30
ramp.color_ramp.elements[0].color = lin('3A2420')
ramp.color_ramp.elements[1].position = 0.78
ramp.color_ramp.elements[1].color = lin('FFF3EA')
mid = ramp.color_ramp.elements.new(0.52)
mid.color = lin('AD8372')
norm = wt.nodes.new('ShaderNodeMapRange')
norm.inputs['From Min'].default_value = -1
wt.links.new(sep.outputs['Z'], norm.inputs[0])
wt.links.new(norm.outputs[0], ramp.inputs[0])
wt.links.new(ramp.outputs[0], bg.inputs[0])
bg.inputs[1].default_value = WORLD
sc.render.engine = 'CYCLES'
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.view_settings.view_transform = 'AgX'
sc.view_settings.look = 'AgX - Base Contrast'
sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = 1024
sc.render.filepath = str(SRC / 'metal.png')
bpy.ops.render.render(write_still=True)
