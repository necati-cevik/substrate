"""Perception and decision: what an entity sees and which rule fires."""
from .config import READ_FRAC
from .hexgrid import hdist
from .grammar import OPS
from .rules import _num_value

# ---------------------------------------------------------------- sense (decision 7 step 2)
def view_of(e, ents, cells):
    r = max(1, int(e.stat["sense"]))
    seen_e = [o for o in ents if o is not e and o.alive and hdist(o.pos, e.pos) <= r]
    seen_c = {p: c for p, c in cells.items()
              if c.amount > 0.01 and hdist(p, e.pos) <= r}
    return seen_e, seen_c

def nearest_entity(e, seen_e):
    return min(seen_e, key=lambda o: hdist(o.pos, e.pos)) if seen_e else None

def read_radius(e):
    """decision 23: another entity's stats are legible at half your sense range. Presence
    carries further than detail, so who is there and what shape they are in are two
    different ranges."""
    return max(1, int(e.stat["sense"] * READ_FRAC))

def nearest_readable(e, seen_e):
    """The nearest entity close enough to read -- not the nearest entity, since one you
    cannot read is not a subject the condition can be about (decision 9)."""
    r = read_radius(e)
    near = [o for o in seen_e if hdist(o.pos, e.pos) <= r]
    return nearest_entity(e, near)

def nearest_source(e, seen_c, stat, sign=None):
    """A source is named by (stat, sign) -- the same pair that types actions and keys
    skill. Without the sign, a healing cell and a damaging one are the same target and no
    rule list can tell them apart."""
    best, bd = None, None
    for p, c in seen_c.items():
        if c.stat != stat or (sign is not None and (c.delta > 0) != (sign > 0)):
            continue
        d = hdist(p, e.pos)
        if bd is None or d < bd:
            best, bd = p, d
    return best

def resolve_selector(e, sel, seen_e, seen_c, subject=None):
    """decision 22: a resolved target is (kind, pos) -- what it is, not just where. `it` takes
    both from the condition's subject, so acting on it gathers or hits as the subject demands."""
    if sel[0] == "it":
        return subject
    if sel[0] == "entity":
        o = nearest_entity(e, seen_e)
        return ("entity", o.pos) if o else None
    p = nearest_source(e, seen_c, sel[1], sel[2])
    return ("source", p) if p is not None else None

def test(e, cond, seen_e, seen_c):
    """decision 22: returns (verdict, subject) -- the one thing the condition was about, as a
    resolved target, or None when it named no single thing."""
    k = cond[0]
    if k == "always":
        return True, None
    if k == "self":
        return OPS[cond[2]](e.stat[cond[1]], _num_value(cond[3], e)), None
    if k == "other":
        o = nearest_readable(e, seen_e)
        if o is None:
            return False, None
        return OPS[cond[2]](o.stat[cond[1]], _num_value(cond[3], e)), ("entity", o.pos)
    if k == "count_entity":
        return OPS[cond[1]](len(seen_e), _num_value(cond[2], e)), None
    if k == "amount":
        p = nearest_source(e, seen_c, cond[1], cond[2])
        if p is None:
            return False, None
        return OPS[cond[3]](seen_c[p].amount, _num_value(cond[4], e)), ("source", p)
    if k == "dist_entity":
        o = nearest_entity(e, seen_e)
        if o is None:
            return False, None
        return OPS[cond[1]](hdist(o.pos, e.pos), _num_value(cond[2], e)), ("entity", o.pos)
    if k == "dist_source":
        p = nearest_source(e, seen_c, cond[1], cond[2])
        if p is None:
            return False, None
        return OPS[cond[3]](hdist(p, e.pos), _num_value(cond[4], e)), ("source", p)
    return False, None

def test_all(e, conds, seen_e, seen_c):
    """decision 22, extended: every condition must hold (AND). `it` binds to the subject of
    the last condition that produced one, so the action names the most specific thing the
    rule was tested against."""
    subject = None
    for cond in conds:
        ok, sub = test(e, cond, seen_e, seen_c)
        if not ok:
            return False, None
        if sub is not None:
            subject = sub
    return True, subject


