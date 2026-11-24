"""Sculpt the Ribbon + Fan ear-wing as one clay mesh."""
import numpy as np

import studio


def carve(u, v, thickness, color):
    along = (u - .36) / .31
    across = (v - (.03 - .23 * along)) / .61
    radius = np.hypot(along, across)
    bowl = np.exp(-2.1 * radius ** 2)
    lip = np.exp(-((radius - .93) / .19) ** 2)
    # Leave the two faces joined at the tapered tip.
    fade_at_tip = 1 - studio.smooth(u, .90, 1)
    inside = studio.smooth(u, .015, .15) * (1 - v ** 2) * fade_at_tip

    # Shallow grooves travel out of the cavity into the scalloped edge.
    trailing = studio.smooth(-v, -.18, .78)
    trailing *= studio.smooth(u, .30, .48)
    trailing *= fade_at_tip
    phase = 5 * ((u - .32) / .68 + .23 * (1 + v))
    grooves = trailing * (.5 + .5 * np.cos(2 * np.pi * phase)) ** 6
    front = thickness + inside * (.085 * lip - .15 * bowl) - .115 * grooves
    front = np.maximum(front, -.65 * thickness)

    tint = (.48 * bowl * inside + .10 * grooves).ravel()[:, None]
    pigment = color * (1 - tint) + np.array(studio.lin3("AD6151")) * tint
    return front, pigment


def make_wing(points, side, clay, *, folded=False):
    spine = studio.Spine(points, flip=folded)
    layer = dict(studio.FOLD["layers"][0], Wl=.56, Wt=.75, T=.19, b=1.3 if folded else 1,
                 depth=.42, u0=.32, cols=("E1A48B", "FFF3DC"), grad=(.20, .85), cup=.12)
    studio.sheet("Ear wing", spine, layer, side < 0, 0, clay, nu=96, nv=24, sculpt=carve)
