"""Human-readable rule text and the ASCII map render."""
from .config import MAP_RADIUS
from .world import archetype

# ---------------------------------------------------------------- readable forms
def fmt_sel(sel):
    if sel[0] == "it":
        return "it"
    if sel[0] == "entity":
        return "nearest entity"
    if sel[0] == "random":
        return "a random hex"
    return f"nearest {'+' if sel[2] > 0 else '-'}{sel[1]} source"

def fmt_cond(c):
    k = c[0]
    if k == "always":       return "always"
    if k == "self":         return f"self.{c[1]} {c[2]} {c[3]}"
    if k == "other":        return f"nearest.{c[1]} {c[2]} {c[3]}"
    if k == "count_entity": return f"count(entities) {c[1]} {c[2]}"
    if k == "amount":       return f"amount({fmt_sel(('source', c[1], c[2]))}) {c[3]} {c[4]}"
    if k == "dist_entity":  return f"dist(nearest entity) {c[1]} {c[2]}"
    if k == "dist_source":  return f"dist({fmt_sel(('source', c[1], c[2]))}) {c[3]} {c[4]}"
    return str(c)

def fmt_conds(cs):
    return " and ".join(fmt_cond(c) for c in cs)

def fmt_act(a):
    if a[0] == "move":
        if a[1][0] == "random" and a[2] > 0:
            return "move randomly"
        return f"move {'toward' if a[2] > 0 else 'away from'} {fmt_sel(a[1])}"
    sel = a[1]
    if sel[0] == "source":
        return f"act on {fmt_sel(sel)}"
    return f"act {'+' if a[3] > 0 else '-'}{a[2]} on {fmt_sel(sel)}"

def render(world):
    cells, ents = world["cells"], world["ents"]
    occ = {e.pos: e for e in ents if e.alive}
    lines = []
    for r in range(-MAP_RADIUS, MAP_RADIUS+1):
        row = " " * abs(r)
        for q in range(-MAP_RADIUS, MAP_RADIUS+1):
            if abs(q+r) > MAP_RADIUS:
                continue
            p = (q, r)
            if p in occ:
                row += "@ "
            elif p in cells and cells[p].amount > 0.5:
                row += ("+ " if cells[p].delta > 0 else "x ")
            else:
                row += ". "
        lines.append(row)
    return "\n".join(lines)
