"""Render the two take B poses as transparent PNGs for export.py."""
import math
import sys
from pathlib import Path
import numpy as np
import bpy
import bmesh
from mathutils import Vector

PI = math.pi


# ------------------------------------------------------------------ colour
def lin1(v):
    return ((v + .055) / 1.055) ** 2.4 if v > .04045 else v / 12.92


def hex3(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def lin3(h):
    return tuple(lin1(c) for c in hex3(h))


def mat(name, h=None, vcol=False, rough=.64, bump=.12, grain=165, sheen=.3):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    t = m.node_tree
    p = t.nodes.get("Principled BSDF")
    if vcol:
        a = t.nodes.new("ShaderNodeAttribute")
        a.attribute_name = "Col"
        t.links.new(a.outputs["Color"], p.inputs["Base Color"])
    else:
        p.inputs["Base Color"].default_value = (*lin3(h), 1)
    p.inputs["Roughness"].default_value = rough
    if "Sheen Weight" in p.inputs:
        p.inputs["Sheen Weight"].default_value = sheen
    noise = t.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = grain
    b = t.nodes.new("ShaderNodeBump")
    b.inputs["Strength"].default_value = bump
    b.inputs["Distance"].default_value = .002
    t.links.new(noise.outputs["Fac"], b.inputs["Height"])
    t.links.new(b.outputs["Normal"], p.inputs["Normal"])
    return m


# ------------------------------------------------------------------ small parts (from astra/studio.py)
def finish(o, m):
    o.data.materials.append(m)
    if o.type == "MESH":
        for f in o.data.polygons:
            f.use_smooth = True
    return o


def bean(name, xyz, scale, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=40, location=xyz)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    o.rotation_euler = rot
    return finish(o, m)


def line(name, coords, radius, m):
    c = bpy.data.curves.new(name, "CURVE")
    c.dimensions = "3D"
    c.resolution_u = 24
    c.bevel_depth = radius
    c.bevel_resolution = 6
    s = c.splines.new("BEZIER")
    s.bezier_points.add(len(coords) - 1)
    for p, co in zip(s.bezier_points, coords):
        p.co = co
        p.handle_left_type = p.handle_right_type = "AUTO"
    o = bpy.data.objects.new(name, c)
    bpy.context.collection.objects.link(o)
    finish(o, m)
    for co in (coords[0], coords[-1]):
        bean(name, co, (radius,) * 3, m)


def quill(a, b, bend, width, depth, m):
    a, b, c = map(Vector, (a, b, bend))
    verts = []
    faces = []
    for j in range(49):
        t = j / 48
        pos = (1 - t) ** 2 * a + 2 * t * (1 - t) * c + t * t * b
        d = ((1 - t) * (c - a) + t * (b - c)).normalized()
        normal = Vector((-d.z, 0, d.x)).normalized()
        size = max(.002, math.sin(PI * t) ** .58) * (1.35 - .7 * t)
        for k in range(32):
            u = 2 * PI * k / 32
            verts.append(pos + size * (normal * width * math.cos(u) + Vector((0, depth * math.sin(u), 0))))
            if j:
                i = j * 32 + k
                h = j * 32 + (k + 1) % 32
                faces.append((i, h, h - 32, i - 32))
    faces.extend([tuple(reversed(range(32))), tuple(range(48 * 32, 49 * 32))])
    mesh = bpy.data.meshes.new("Stalk")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    o = bpy.data.objects.new("Stalk", mesh)
    bpy.context.collection.objects.link(o)
    finish(o, m)


HEAD_Z = -.10
HEAD_S = 1.35


def head(M, closed_eyes=False):
    z, s = HEAD_Z, HEAD_S
    bean("Head", (0, 0, z), (.69 * s, .55 * s, .71 * s), M["skin"])
    for sg in (-1, 1):
        if closed_eyes:   # sleeping: two soft arcs
            line("Lid", [(sg * .255 * s + dx * s, -.5 * s, z + .015 * s + dz * s)
                         for dx, dz in [(-.062, .02), (0, -.012), (.062, .02)]], .02 * s, M["ink"])
        else:
            bean("Eye", (sg * .255 * s, -.503 * s, z + .015 * s), (.063 * s, .035 * s, .071 * s), M["ink"])
        bean("Cheek", (sg * .43 * s, -.47 * s, z - .1 * s), (.1 * s, .03 * s, .065 * s), M["cheek"])
    bean("Nose", (0, -.55 * s, z - .091 * s), (.115 * s, .095 * s, .081 * s), M["skin"])
    line("Smile", [(x * s, -.505 * s, z + v * s) for x, v in [(-.096, -.235), (0, -.26), (.096, -.235)]],
         .022 * s, M["ink"])
    # sage beret
    c = z
    bean("Beret band", (0, -.011 * s, c + .40 * s), (.648 * s, .515 * s, .114 * s), M["band"], (0, -.11, 0))
    bean("Beret", (-.064 * s, 0, c + .49 * s), (.69 * s, .535 * s, .32 * s), M["sage"], (0, -.11, 0))
    quill((-.27 * s, 0, c + .71 * s), (.05 * s, .02, c + .97 * s), (-.19 * s, 0, c + .98 * s),
          .087 * s, .072 * s, M["sage"])


# ------------------------------------------------------------------ ear-wing
class Spine:
    """Cubic Bezier in 3D, sampled by arc length. The frame: T tangent,
    N in the image plane (leading side), B toward the camera."""

    def __init__(self, pts, flip=False):
        self.flip = flip
        P = np.array(pts, float)
        t = np.linspace(0, 1, 1200)[:, None]
        self.pos = ((1 - t) ** 3 * P[0] + 3 * (1 - t) ** 2 * t * P[1] + 3 * (1 - t) * t * t * P[2] + t ** 3 * P[3])
        d = np.gradient(self.pos, axis=0)
        self.tan = d / np.linalg.norm(d, axis=1)[:, None]
        seg = np.linalg.norm(np.diff(self.pos, axis=0), axis=1)
        self.arc = np.concatenate([[0], np.cumsum(seg)])
        self.length = self.arc[-1]

    def frame(self, s):
        s = np.clip(s, 0, self.length)
        pos = np.stack([np.interp(s, self.arc, self.pos[:, k]) for k in range(3)], -1)
        T = np.stack([np.interp(s, self.arc, self.tan[:, k]) for k in range(3)], -1)
        T /= np.linalg.norm(T, axis=-1)[:, None]
        N = np.stack([-T[:, 2], np.zeros(len(s)), T[:, 0]], -1)          # CCW in the image plane
        N = N - (N * T).sum(-1)[:, None] * T
        N /= np.linalg.norm(N, axis=-1)[:, None]
        if self.flip:
            N = -N
        B = np.cross(T, N)
        B *= -np.sign(B[:, 1])[:, None]                                   # always toward the camera (-y)
        return pos, T, N, B


def prof(u, a, b):
    peak = (a / (a + b)) ** a * (b / (a + b)) ** b
    return np.clip(u, 0, 1) ** a * np.clip(1 - u, 0, 1) ** b / peak


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def make_obj(name, verts, faces, cols, material, mirror, weld=True):
    verts = np.asarray(verts, float)
    if mirror:
        verts = verts * np.array([-1, 1, 1])
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts.tolist(), [], faces)
    me.update()
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    flat = np.concatenate([np.asarray(cols, float), np.ones((len(cols), 1))], 1).ravel()
    ca.data.foreach_set("color", flat)
    bm = bmesh.new()
    bm.from_mesh(me)
    if weld:
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    finish(o, material)
    return o


def lerp3(c0, c1, k):
    return np.array(lin3(c0))[None, :] * (1 - k[:, None]) + np.array(lin3(c1))[None, :] * k[:, None]


def edge_fn(L, which):
    """Half-width of a layer (leading or trailing) as a function of u in 0..1,
    with scallops cut into the trailing edge."""
    def f(u):
        if which == "lead":
            return L["Wl"] * prof(u, L["a"], L["b"])
        w = L["Wt"] * prof(u, L.get("a2", L["a"]), L.get("b2", L["b"]))
        n = L.get("n", 0)
        if n:
            u0 = L.get("u0", .3)
            ph = np.clip((u - u0) / (1 - u0), 0, 1)
            lobe = np.abs(np.sin(PI * n * ph)) ** .55
            lobe = np.where(u > u0, lobe, 1.0)
            return w * (1 - L["depth"] * (1 - lobe))
        return w
    return f


def lobe_env(L, u):
    n = L.get("n", 0)
    if not n:
        return np.ones_like(u)
    u0 = L.get("u0", .3)
    ph = np.clip((u - u0) / (1 - u0), 0, 1)
    return np.where(u > u0, np.abs(np.sin(PI * n * ph)) ** .55, 1.0)


def sheet(name, spine, L, mirror, ydep, M, nu=150, nv=34):
    Lt = spine.length
    s0 = L.get("s0", 0) * Lt
    ln = L["len"] * Lt
    k = np.arange(nu + 1) / nu
    u = (1 - np.cos(PI * k)) / 2
    v = np.sin(np.linspace(-PI / 2, PI / 2, 2 * nv + 1))
    U, V = np.meshgrid(u, v, indexing="ij")
    lead = edge_fn(L, "lead")(U)
    trail = edge_fn(L, "trail")(U)
    t = np.where(V >= 0, V * lead, V * trail) + L.get("t0", 0)
    env = lobe_env(L, U)
    ends = np.minimum(1, np.minimum(np.sqrt(U / .09), np.sqrt((1 - U) / .14)))
    side = np.where(V < 0, 1 - .55 * (1 - env) * np.abs(V) ** 1.5, 1.0)
    h = L["T"] * np.sqrt(np.clip(1 - V * V, 0, 1)) * ends * side
    s = s0 + U * ln
    pos, T, N, B = spine.frame(s.ravel())
    pos = pos.reshape(U.shape + (3,))
    N = N.reshape(U.shape + (3,))
    B = B.reshape(U.shape + (3,))
    cup = L.get("cup", 0)
    tt = t[..., None]
    nvv = V.shape[1]
    verts = []
    cols = []
    gl = (s / Lt).ravel()
    if "solid" in L:
        cc = np.tile(lin3(L["solid"]), (len(gl), 1))
    else:
        cc = lerp3(L["cols"][0], L["cols"][1], smooth(gl, *L["grad"]))
    for sg in (1, -1):
        p = pos + N * tt + B * (ydep + L.get("y", 0) + sg * h[..., None]) - B * cup * tt ** 2
        verts.append(p.reshape(-1, 3))
        cols.append(cc)
    nf = U.size
    faces = []
    for i in range(nu):
        for j in range(nvv - 1):
            a = i * nvv + j
            b = a + 1
            c = a + nvv + 1
            d = a + nvv
            faces.append((a, d, c, b))
            faces.append((nf + a, nf + b, nf + c, nf + d))
    o = make_obj(name, np.concatenate(verts), faces, np.concatenate(cols), M["vc"], mirror)
    return o, (spine, s0, ln, L, ydep)


def point_on(spine, s, tv, ydep, up=0.0, cup=0.0):
    pos, T, N, B = spine.frame(np.atleast_1d(np.asarray(s, float)))
    tv = np.atleast_1d(tv)[:, None]
    return pos + N * tv + B * (ydep + up) - B * cup * tv ** 2, N, B


def tube(name, P, R, Nn, Bn, cols, M, mirror, sides=18):
    n = len(P)
    verts = []
    cc = []
    for i in range(n):
        for k in range(sides):
            th = 2 * PI * k / sides
            verts.append(P[i] + R[i] * (math.cos(th) * Nn[i] + math.sin(th) * Bn[i]))
            cc.append(cols[i])
    faces = []
    for i in range(n - 1):
        for k in range(sides):
            a = i * sides + k
            b = i * sides + (k + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    # end caps are radius ~0, welded by remove_doubles
    return make_obj(name, verts, faces, cc, M["vc"], mirror)


def rim(spine, base, ydep, M, mirror):
    Lt = spine.length
    ln = base["len"] * Lt
    u = (1 - np.cos(PI * np.linspace(0.02, 1, 140))) / 2
    lead = edge_fn(base, "lead")(u)
    s = u * ln
    P, N, B = point_on(spine, s, lead + base.get("t0", 0), ydep + base.get("y", 0), cup=base.get("cup", 0))
    R = base["rim"] * smooth(u, 0, .12) * np.clip(1 - u, 0, 1) ** .45
    g = smooth(s / Lt, *base["grad"])
    cc = lerp3(base["cols"][0], base["cols"][1], g)
    return tube("Rim", P, R, N, B, cc, M, mirror)


def concha(spine, C, ydep, M, mirror):
    L = dict(C, a=.8, b=.8, Wl=C["W"], Wt=C["W"], grad=(0, 1), T=C["T"])
    o, _ = sheet("Concha", spine, L, mirror, ydep, M, nu=60, nv=22)
    # three nested arcs, the Echo bands, raised on the concha
    Lt = spine.length
    cs = (C["s0"] + C["len"] / 2) * Lt
    ct = C.get("t0", 0)
    half = C["len"] * Lt / 2
    for i, k in enumerate((.74, .5, .26)):
        th = np.linspace(-1.95, 1.95, 50)
        sr = cs + .12 * half + k * half * .9 * np.cos(th)
        tr = ct + k * C["W"] * .85 * np.sin(th)
        P, N, B = point_on(spine, sr, tr, ydep + C.get("y", 0), up=C["T"] * .8)
        taper = np.sin(np.linspace(0, PI, 50)) ** .5
        R = C["arc_r"] * (.35 + .65 * taper)
        cc = np.tile(lin3(C["arc_col"]), (50, 1))
        tube("Band %d" % i, P, R, N, B, cc, M, mirror, sides=12)
    return o


# ------------------------------------------------------------------ takes
COL_BACK = ("E8B39B", "F5E7D2")
COL_MID = ("F0C2AA", "FAF0DE")
COL_FRONT = ("F5CEB8", "FFF8EA")
COL_RIM = ("F0BFA7", "FFF4E2")


def layers(spec):
    out = []
    pal = [COL_BACK, COL_MID, COL_FRONT]
    for i, d in enumerate(spec):
        d = dict(d)
        d.setdefault("cols", pal[min(i, len(pal) - 1)])
        out.append(d)
    return out


FOLD = dict(
    open=[(0.80, .02, -.14), (1.35, .0, -.12), (1.85, .0, .4), (2.0, .0, 1.15)],
    base=dict(len=1, Wl=.5, Wt=.72, a=.5, b=1.0, T=.11, rim=.12, grad=(.3, .8)),
    layers=layers([
        dict(len=1, Wl=.46, Wt=.70, a=.5, b=1.0, T=.105, n=5, depth=.26, u0=.34, grad=(.3, .8), y=0),
        dict(len=.84, Wl=.42, Wt=.5, a=.5, b=1.0, T=.095, n=4, depth=.26, u0=.34, grad=(.28, .75), y=.07),
        dict(len=.62, Wl=.36, Wt=.3, a=.5, b=1.0, T=.085, n=3, depth=.26, u0=.36, grad=(.25, .7), y=.13),
    ]),
    concha=dict(s0=.04, len=.34, W=.22, t0=-.1, T=.07, y=.30, solid="D4806C",
                arc_r=.02, arc_col="F1BBA6"),
    wrapped=dict(R=[(.8, .02, -.14), (1.2, -.3, -.75), (1.0, -.75, -1.25), (.3, -.95, -1.4)], cross=-.45),
)


def wing(pose, side, M):
    """side +1 right (screen), -1 left (mirrored)."""
    spec = FOLD
    if pose == "open":
        pts = spec["open"]
        ydep = 0
    else:
        pts = [list(p) for p in spec["wrapped"]["R"]]
        pts[3][0] = spec["wrapped"]["cross"]      # both tips cross the centre line, right wing in front
        ydep = 0
        if side > 0:
            pts[3][1] -= .3
            pts[2][1] -= .15
    sp = Spine(pts, flip=(pose == "wrapped"))
    mirror = side < 0
    for L in spec["layers"]:
        sheet("Wing layer", sp, L, mirror, ydep, M)
    base = dict(spec["base"], cols=COL_RIM)
    rim(sp, base, ydep, M, mirror)
    concha(sp, spec["concha"], ydep, M, mirror)


# ------------------------------------------------------------------ scene
def aim(o, target):
    o.rotation_euler = (Vector(target) - o.location).to_track_quat("-Z", "Y").to_euler()


def light(name, loc, target, power, size, color=(1, 1, 1)):
    bpy.ops.object.light_add(type="AREA", location=loc)
    o = bpy.context.object
    o.name = name
    o.data.energy = power
    o.data.shape = "DISK"
    o.data.size = size
    o.data.color = color
    if name.startswith("Rim"):
        o.data.specular_factor = .15     # rim light adds edge glow, not glass-like highlights
    aim(o, target)
    return o


def bbox_xz():
    lo = np.array([1e9, 1e9])
    hi = -lo
    dg = bpy.context.evaluated_depsgraph_get()
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or o.name.startswith(("Lid", "Smile")):
            continue
        ob = o.evaluated_get(dg)
        me = ob.to_mesh()
        v = np.array([(o.matrix_world @ p.co)[:] for p in me.vertices])
        ob.to_mesh_clear()
        lo = np.minimum(lo, v[:, [0, 2]].min(0))
        hi = np.maximum(hi, v[:, [0, 2]].max(0))
    return lo, hi


def render(pose, path, resolution, fill):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    M = dict(
        vc=mat("Ear-wing clay", vcol=True, rough=.78, sheen=.08),
        skin=mat("Honey", "E39A74"), cheek=mat("Cheek", "DE8F78"), ink=mat("Umber", "2A1E1C", rough=.5),
        sage=mat("Eucalyptus", "6F9080"),
        band=mat("Deep sage", "4F6B5E"),
    )
    head(M, closed_eyes=(pose == "wrapped"))
    wing(pose, 1, M)
    wing(pose, -1, M)
    # whole figure tilts a little when asleep
    rig = bpy.data.objects.new("Rig", None)
    bpy.context.collection.objects.link(rig)
    for o in list(bpy.context.scene.objects):
        if o is not rig and o.type in {"MESH", "CURVE"}:
            o.parent = rig
    rig.rotation_euler.y = math.radians(-7 if pose == "wrapped" else 0)
    bpy.context.view_layer.update()
    lo, hi = bbox_xz()
    ctr = (lo + hi) / 2
    span = (hi - lo).max()
    ortho = span / fill
    bpy.ops.object.camera_add(location=(ctr[0], -9, ctr[1]))
    cam = bpy.context.object
    cam.rotation_euler = (PI / 2, 0, 0)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = ortho
    sc = bpy.context.scene
    sc.camera = cam
    tgt = (ctr[0], 0, ctr[1])
    light("Softbox", (ctr[0] - 3.5, -5, ctr[1] + 5.7), tgt, 560, 4)
    light("Fill", (ctr[0] + 3.8, -3, ctr[1] + 3), tgt, 260, 4)
    light("Top", (ctr[0] - 1, -.4, ctr[1] + 6), tgt, 260, 2.8)
    # Warm rims define the silhouette on dark surfaces.
    rim_strength = .50 if pose == "wrapped" else 1.0
    light("Rim L", (ctr[0] - 4.6, 1.6, ctr[1] + 1.2), tgt, rim_strength * 3000, 2.5, (1.0, .82, .68))
    light("Rim R", (ctr[0] + 4.6, 1.6, ctr[1] + 1.2), tgt, rim_strength * 3000, 2.5, (1.0, .9, .8))
    light("Rim Top", (ctr[0], 1.6, ctr[1] + 4.8), tgt, rim_strength * 2200, 3, (1.0, .88, .76))
    sc.world = bpy.data.worlds.new("Studio")
    sc.world.use_nodes = True
    sky = sc.world.node_tree.nodes.get("Background")
    sky.inputs[0].default_value = (.84, .80, .75, 1)
    sky.inputs[1].default_value = .12
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.exposure = .05
    sc.render.film_transparent = True
    sc.render.resolution_x = sc.render.resolution_y = resolution
    sc.render.resolution_percentage = 100
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    out = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    render("wrapped", out / "wrapped.png", 1024, .86)
    render("open", out / "open.png", 3000, .80)
