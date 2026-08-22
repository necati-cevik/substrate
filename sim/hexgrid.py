"""Hex grid geometry: axial coordinates and movement (DESIGN.md decision 6)."""
from .config import MAP_RADIUS

# ---------------------------------------------------------------- hex (decision 6)
DIRS = [(1,0),(1,-1),(0,-1),(-1,0),(-1,1),(0,1)]

def hdist(a, b):
    return (abs(a[0]-b[0]) + abs(a[0]+a[1]-b[0]-b[1]) + abs(a[1]-b[1])) // 2

def hadd(a, b):
    return (a[0]+b[0], a[1]+b[1])

def in_bounds(p):
    return abs(p[0]) <= MAP_RADIUS and abs(p[1]) <= MAP_RADIUS and abs(p[0]+p[1]) <= MAP_RADIUS

def neighbours(pos):
    """The hexes one step from here that are on the map -- what a step may reach."""
    return [c for c in (hadd(pos, d) for d in DIRS) if in_bounds(c)]

def disc(radius, centre=(0,0)):
    out = []
    for q in range(-radius, radius+1):
        for r in range(max(-radius, -q-radius), min(radius, -q+radius)+1):
            out.append(hadd(centre, (q, r)))
    return out

def step_towards(pos, target, sign):
    """One hex step toward (sign +1) or away from (sign -1) target, or stand still if no
    neighbour improves on where you are -- standing on your target is arrival, not a reason
    to step off it."""
    best, bestd = pos, hdist(pos, target) * sign
    for c in neighbours(pos):
        dd = hdist(c, target) * sign
        if dd < bestd:
            best, bestd = c, dd
    return best
