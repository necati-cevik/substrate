"""Substrate sim -- first runnable version of DESIGN.md.

In:  hex arena, clustered resource deltas, entities running 3-4 if/do rules,
     reach attenuation, absorption, upkeep decay, skill, corpse loot, death.
Out: genes, karma, rebirth, reproduction, environment actions. Deferred on purpose.
"""
import random, math
from collections import defaultdict, Counter

# ---------------------------------------------------------------- tuning
MAP_RADIUS   = 10
N_ENTITIES   = 30
TICKS        = 400

K_ABSORB     = 0.05    # decision 12
FALLOFF      = 0.35    # decision 5
POWER        = 5.0     # decision 5: flat magnitude per action (was the capacity stat)
UPKEEP_FLAT  = 0.02    # decision 13 (amended): upkeep accrues as strain, not as decay
UPKEEP_RATE  = 0.004   # ...proportional to what you carry -- the tax on the powerful
STRAIN_K     = 0.08    # how hard unpaid upkeep bites efficiency
STRAIN_DRAIN = 0.045   # hp bled per point of strain per tick
LOOT_PCT     = 0.40    # decision 10
SKILL_GAIN   = 0.06    # decision 15
SKILL_K      = 3.0
SKILL_DECAY  = 0.004
REGROW       = 0.06
READ_FRAC    = 0.5     # decision 23: stats are readable at half your sense range
RES_WEIGHTS  = [6, 2, 2, 1]      # per STATS; the wild is mostly health
N_BLOBS      = 14

STATS  = ["hp", "speed", "sense", "rules"]
START  = {"hp": 20.0, "speed": 2.0, "sense": 6.0, "rules": 4.0}

# ---------------------------------------------------------------- hex (decision 6)
DIRS = [(1,0),(1,-1),(0,-1),(-1,0),(-1,1),(0,1)]

def hdist(a, b):
    return (abs(a[0]-b[0]) + abs(a[0]+a[1]-b[0]-b[1]) + abs(a[1]-b[1])) // 2

def hadd(a, b):
    return (a[0]+b[0], a[1]+b[1])

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
    for d in DIRS:
        c = hadd(pos, d)
        if abs(c[0]) > MAP_RADIUS or abs(c[1]) > MAP_RADIUS or abs(c[0]+c[1]) > MAP_RADIUS:
            continue
        dd = hdist(c, target) * sign
        if dd < bestd:
            best, bestd = c, dd
    return best

# ---------------------------------------------------------------- world
class Cell:
    """decision 11: a resource cell is the action atom minus the actor."""
    __slots__ = ("stat", "delta", "amount", "cap", "wild")
    def __init__(self, stat, delta, amount, wild=True):
        self.stat, self.delta, self.amount = stat, delta, amount
        self.cap, self.wild = amount, wild

class Entity:
    __slots__ = ("id", "pos", "stat", "skill", "strain", "ruleset", "born", "died", "acts", "trail")
    def __init__(self, eid, pos, ruleset):
        self.id, self.pos, self.ruleset = eid, pos, ruleset
        self.stat  = dict(START)
        self.skill = defaultdict(lambda: 1.0)   # (stat, sign) -> percentage modifier
        self.strain = 0.0      # unpaid upkeep. Not a stat: not on the map, not targetable
        self.born, self.died = 0, None
        self.trail = [pos]
        self.acts = Counter()

    @property
    def condition(self):
        """decision 13 (amended): unpaid upkeep is a negative percentage modifier on
        everything you do -- the mirror of skill, same shape as decisions 5 and 12.
        Read off strain, never off hp: a wounded character is not a clumsy one."""
        return 1.0 / (1.0 + STRAIN_K * self.strain)

    @property
    def alive(self):
        return self.stat["hp"] > 0

    def active_rules(self):
        """decision 14: the rules stat is the slot count -- scaled by condition, so
        desperation still strips you to your top priorities."""
        n = max(1, int(round(self.stat["rules"] * self.condition)))
        return self.ruleset[:n]

# ---------------------------------------------------------------- rule grammar (decision 16)
# condition: what the model already contains, nothing more
#   ("self", stat, op, v) | ("other", stat, op, v) | ("dist_entity", op, v)
#   ("dist_source", stat, op, v) | ("count_entity", op, v) | ("always",)
# action:
#   ("move", selector, sign) | ("act", selector, stat, sign)
# selector: ("entity",) | ("source", stat, sign) | ("it",)   -- decision 22

OPS = {"<": lambda a, b: a < b, ">": lambda a, b: a > b}

def rand_selector(rng):
    if rng.random() < 0.4:
        return ("entity",)
    return ("source", rand_stat(rng), 1 if rng.random() < 0.8 else -1)

def rand_stat(rng):
    return rng.choices(STATS, weights=[5, 2, 2, 1])[0]

def rand_condition(rng):
    k = rng.random()
    if k < 0.30:
        s = rand_stat(rng)
        return ("self", s, rng.choice("<>"), round(START[s] * rng.uniform(0.3, 1.1), 2))
    if k < 0.42:
        s = rand_stat(rng)
        return ("other", s, rng.choice("<>"), round(START[s] * rng.uniform(0.3, 1.1), 2))
    if k < 0.60:
        return ("dist_entity", rng.choice("<>"), rng.randint(1, 6))
    if k < 0.85:
        return ("dist_source", rand_stat(rng), 1 if rng.random() < 0.8 else -1,
                rng.choice("<>"), rng.randint(1, 6))
    if k < 0.93:
        return ("count_entity", rng.choice("<>"), rng.randint(1, 4))
    return ("amount", rand_stat(rng), 1 if rng.random() < 0.8 else -1,
            rng.choice("<>"), rng.randint(2, 20))

def rand_action(rng):
    sel = rand_selector(rng)
    if rng.random() < 0.45:
        return ("move", sel, 1 if rng.random() < 0.75 else -1)
    if sel[0] == "source":
        return ("act", sel, sel[1], sel[2])                  # gathering
    return ("act", sel, rand_stat(rng), 1 if rng.random() < 0.35 else -1)

def rand_rules(rng, n):
    """Semi-random: n-1 random rules, then a guaranteed fallback so nobody is inert."""
    rules = [(rand_condition(rng), rand_action(rng)) for _ in range(n - 1)]
    rules.append((("always",), ("move", ("source", "hp", 1), 1)))   # go find food
    return rules

# ---------------------------------------------------------------- rule schema (decision 21)
# The grammar restated as data, so the editor is generated from it instead of duplicating it.
COND_SPEC = {
    "always":       [],
    "self":         ["stat", "op", "num"],
    "other":        ["stat", "op", "num"],
    "dist_entity":  ["op", "num"],
    "dist_source":  ["stat", "sign", "op", "num"],
    "count_entity": ["op", "num"],
    "amount":       ["stat", "sign", "op", "num"],
}
ACT_SPEC = {
    "move": ["sel", "sign"],
    "act":  ["sel", "stat", "sign"],
}
SEL_SPEC = {
    "entity": [],
    "source": ["stat", "sign"],
    "it":     [],                # decision 22: whatever the condition matched
}

def _field(kind, v):
    if kind == "stat":
        if v not in STATS:
            raise ValueError(f"not a stat: {v!r}")
        return v
    if kind == "op":
        if v not in OPS:
            raise ValueError(f"not an operator: {v!r}")
        return v
    if kind == "sign":
        if v not in (1, -1):
            raise ValueError(f"sign must be 1 or -1, got {v!r}")
        return v
    if kind == "num":
        return round(float(v), 2)
    if kind == "sel":
        return _parse(SEL_SPEC, v, "selector")
    raise ValueError(f"unknown field kind {kind!r}")

def _parse(spec, v, what):
    if not isinstance(v, (list, tuple)) or not v:
        raise ValueError(f"{what}: expected [kind, ...], got {v!r}")
    kind, fields = v[0], spec.get(v[0])
    if fields is None:
        raise ValueError(f"{what}: unknown kind {kind!r}")
    if len(v) - 1 != len(fields):
        raise ValueError(f"{what} {kind}: takes {len(fields)} field(s), got {len(v) - 1}")
    return (kind,) + tuple(_field(f, x) for f, x in zip(fields, v[1:]))

def parse_ruleset(v):
    """Validate a ruleset off the wire. Legal or rejected -- decision 9 is about bad
    information inside the sim, not about letting malformed rules into it."""
    if not isinstance(v, list) or not v:
        raise ValueError("ruleset must be a non-empty list")
    out = []
    for i, r in enumerate(v):
        if not isinstance(r, (list, tuple)) or len(r) != 2:
            raise ValueError(f"rule {i}: expected [condition, action]")
        out.append((_parse(COND_SPEC, r[0], f"rule {i} condition"),
                    _parse(ACT_SPEC, r[1], f"rule {i} action")))
    return out

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
        return OPS[cond[2]](e.stat[cond[1]], cond[3]), None
    if k == "other":
        o = nearest_readable(e, seen_e)
        if o is None:
            return False, None
        return OPS[cond[2]](o.stat[cond[1]], cond[3]), ("entity", o.pos)
    if k == "count_entity":
        return OPS[cond[1]](len(seen_e), cond[2]), None
    if k == "amount":
        p = nearest_source(e, seen_c, cond[1], cond[2])
        if p is None:
            return False, None
        return OPS[cond[3]](seen_c[p].amount, cond[4]), ("source", p)
    if k == "dist_entity":
        o = nearest_entity(e, seen_e)
        if o is None:
            return False, None
        return OPS[cond[1]](hdist(o.pos, e.pos), cond[2]), ("entity", o.pos)
    if k == "dist_source":
        p = nearest_source(e, seen_c, cond[1], cond[2])
        if p is None:
            return False, None
        return OPS[cond[3]](hdist(p, e.pos), cond[4]), ("source", p)
    return False, None

def decide(e, seen_e, seen_c):
    """decision 14: first rule whose condition holds; none holds = idle. Carries out the
    condition's subject too (decision 22), so the action can name it."""
    for i, (cond, act) in enumerate(e.active_rules()):
        ok, subject = test(e, cond, seen_e, seen_c)
        if ok:
            return i, cond, act, subject
    return None

# ---------------------------------------------------------------- readable forms
def fmt_sel(sel):
    if sel[0] == "it":
        return "it"
    if sel[0] == "entity":
        return "nearest entity"
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

def fmt_act(a):
    if a[0] == "move":
        return f"move {'toward' if a[2] > 0 else 'away from'} {fmt_sel(a[1])}"
    return f"act {'+' if a[3] > 0 else '-'}{a[2]} on {fmt_sel(a[1])}"

# ---------------------------------------------------------------- resolution
def deliver(e, stat, sign, dist):
    """decision 5 + 15 + 13: flat power, scaled by skill and by condition, attenuated by reach.
    Reach is measured from adjacency (decision 20): touching range is full effect."""
    return POWER * e.skill[(stat, sign)] * e.condition / (1 + FALLOFF * max(0, dist - 1))

def absorb(target_level, raw):
    """decision 12."""
    return raw / (1 + K_ABSORB * max(0.0, target_level))

def run_tick(world, tick):
    ents, cells = world["ents"], world["cells"]
    alive = [e for e in ents if e.alive]
    ev = []
    def log(eid, kind, **kw):
        ev.append(dict(t=tick, e=eid, kind=kind, **kw))

    # 1. SNAPSHOT + 2. SENSE + 3. DECIDE
    # R1: decisions are all computed before any mutation below, so every entity reads the
    # same frozen world. No copy needed as long as nothing here writes.
    intents = []
    for e in alive:
        seen_e, seen_c = view_of(e, alive, cells)
        d = decide(e, seen_e, seen_c)
        if d is None:
            intents.append((e, None, None, None))
            log(e.id, "idle", why="no rule matched")
            continue
        idx, cond, act, subject = d
        tgt = resolve_selector(e, act[1], seen_e, seen_c, subject)
        intents.append((e, idx, act, tgt))
        if tgt is None:
            # decision 9: bad or missing information wastes the slot, never illegal
            log(e.id, "wasted", rule=idx, cond=fmt_cond(cond), act=fmt_act(act),
                why=("the condition named no target" if act[1][0] == "it"
                     else f"{fmt_sel(act[1])} not perceived"))

    occupancy = defaultdict(list)
    for e in alive:
        occupancy[e.pos].append(e)

    # 4. RESOLVE
    moves = []
    for e, idx, act, resolved in intents:
        if act is None or resolved is None:
            continue
        kind, tgt = resolved
        if act[0] == "move":
            steps = max(1, int(round(e.stat["speed"] * e.condition)))  # R3; degraded, never frozen
            path = [e.pos]
            for _ in range(steps):
                path.append(step_towards(path[-1], tgt, act[2]))       # decision 20: paths pass through
            moves.append((e, idx, act, tgt, path, steps))
            continue

        _, sel, stat, sign = act
        d = hdist(e.pos, tgt)
        if kind == "source":
            c = cells.get(tgt)
            if c is None or c.amount <= 0.01:
                log(e.id, "wasted", rule=idx, act=fmt_act(act), why="source is empty")
                continue
            draw = min(c.amount, deliver(e, stat, sign, d))
            c.amount -= draw
            got = absorb(e.stat[c.stat], draw * (1 if c.delta > 0 else -1))
            e.stat[c.stat] += got
            hazard = c.delta < 0
            if not hazard:
                e.strain = max(0.0, e.strain - draw)   # feeding is any draw from the wild
            e.acts["graze_hazard" if hazard else "gather"] += 1
            log(e.id, "hazard" if hazard else "gather", rule=idx, act=fmt_act(act),
                stat=c.stat, drew=round(draw, 2), got=round(got, 2), dist=d,
                target=list(tgt), left=round(c.amount, 1), strain=round(e.strain, 2))
        else:
            raw = deliver(e, stat, sign, d)
            hit = False
            for t in occupancy.get(tgt, []):
                if t is e:
                    continue
                hit = True
                if sign < 0:
                    took = absorb(t.stat[stat], raw)               # destruction is free
                    # floor at zero: a negative stat makes deliver() negative, which turns
                    # giving into draining and inverts decision 17
                    t.stat[stat] = max(0.0, t.stat[stat] - took)
                    e.acts["harm"] += 1
                    log(e.id, "harm", rule=idx, act=fmt_act(act), stat=stat, victim=t.id,
                        amount=round(took, 2), dist=d, target=list(tgt))
                else:
                    give = min(raw, max(0.0, e.stat[stat]))  # decision 17: creation is funded
                    e.stat[stat] -= give
                    landed = absorb(t.stat[stat], give)
                    t.stat[stat] += landed
                    e.acts["give"] += 1
                    log(e.id, "give", rule=idx, act=fmt_act(act), stat=stat, to_id=t.id,
                        paid=round(give, 2), landed=round(landed, 2), dist=d, target=list(tgt))
            if not hit:
                log(e.id, "wasted", rule=idx, act=fmt_act(act), why="cell was empty")
            bump_skill(e, (stat, sign))

    # decision 20: one entity per hex, and a move takes you as close as it can get. Walk the
    # path; if the far end is taken, fall back one hex along it and try again. A contested cell
    # goes to the fastest claimant -- effective speed, read off the same frozen snapshot, so
    # there is no turn order in it (R1). A stayer always keeps its own cell, and an exact tie
    # yields for everyone. Each round only shortens a path, so this terminates.
    pos0 = {e.id: e.pos for e in alive}
    pace = {e.id: e.stat["speed"] * e.condition for e in alive}
    path = {e.id: [e.pos] for e in alive}
    at   = dict.fromkeys(pos0, 0)
    for e, _, _, _, pth, _ in moves:
        path[e.id], at[e.id] = pth, len(pth) - 1
    while True:
        claims = defaultdict(list)
        for i in pos0:
            claims[path[i][at[i]]].append(i)
        losers = set()
        for ids in claims.values():
            if len(ids) < 2:
                continue
            movers = [i for i in ids if path[i][at[i]] != pos0[i]]
            if len(movers) < len(ids):          # someone is staying put; nobody displaces them
                losers |= set(movers)
                continue
            best = max(pace[i] for i in movers)
            fastest = [i for i in movers if pace[i] == best]
            losers |= set(movers) - (set(fastest) if len(fastest) == 1 else set())
        if not losers:
            break
        for i in losers:
            at[i] -= 1

    for e, idx, act, tgt, pth, steps in moves:
        got = at[e.id]
        if pth[-1] == e.pos:
            # nothing on the map improves on this hex -- arrival, not failure
            e.acts["hold"] += 1
            log(e.id, "hold", rule=idx, act=fmt_act(act), frm=list(e.pos), target=list(tgt),
                dist=hdist(e.pos, tgt), why="already as close as it can get")
            continue
        if pth[got] == e.pos:
            e.acts["blocked"] += 1
            log(e.id, "blocked", rule=idx, act=fmt_act(act), frm=list(e.pos),
                to=list(pth[-1]), target=list(tgt), why="every hex on the path was taken")
            continue
        frm, e.pos = e.pos, pth[got]
        e.trail.append(e.pos)
        del e.trail[:-8]
        e.acts["move"] += 1
        bump_skill(e, ("position", act[2]))
        log(e.id, "move", rule=idx, act=fmt_act(act), frm=list(frm), to=list(e.pos),
            steps=got, wanted=steps, target=list(tgt))

    # upkeep (decision 13, amended) + skill decay (decision 15)
    for e in alive:
        before = len(e.active_rules())
        # upkeep accrues as strain, proportional to everything you carry -- the tax on
        # the powerful. Strain does two things: it weakens what you do, and it bleeds hp.
        e.strain += UPKEEP_FLAT + UPKEEP_RATE * sum(e.stat[s] for s in STATS)
        e.stat["hp"] -= STRAIN_DRAIN * e.strain
        after = len(e.active_rules())
        if after < before:
            log(e.id, "slot_lost", slots=after, why="condition fell; bottom rule dropped")
        for k in list(e.skill):
            e.skill[k] = max(1.0, e.skill[k] - SKILL_DECAY)

    # 5. REAP (R4) -- corpses become cells (decision 11)
    for e in alive:
        if not e.alive:
            e.died = tick
            left = LOOT_PCT * START["hp"]
            c = cells.get(e.pos)
            if c and c.stat == "hp" and c.delta > 0:
                c.amount += left
            else:
                cells[e.pos] = Cell("hp", 2.0, left, wild=False)
            log(e.id, "death", at=list(e.pos), loot=round(left, 1),

                lived=tick - e.born, archetype=archetype(e))

    # the wild creates (decision 10)
    for c in cells.values():
        if c.wild and c.amount < c.cap:
            c.amount = min(c.cap, c.amount + REGROW)

    world["tick"] = tick
    world["log"] = ev
    return ev

def bump_skill(e, key):
    e.skill[key] += SKILL_GAIN / (1 + SKILL_K * (e.skill[key] - 1.0))

# ---------------------------------------------------------------- setup
def make_world(rng):
    cells = {}
    field = disc(MAP_RADIUS)
    for _ in range(N_BLOBS):                                   # clustered deltas (decision 11)
        centre = rng.choice(field)
        stat   = rng.choices(STATS, weights=RES_WEIGHTS)[0]
        hazard = rng.random() < 0.20
        delta  = rng.uniform(1.5, 3.0) * (-1 if hazard else 1)
        for p in disc(rng.randint(1, 3), centre):
            if abs(p[0]) > MAP_RADIUS or abs(p[1]) > MAP_RADIUS or abs(p[0]+p[1]) > MAP_RADIUS:
                continue
            cells[p] = Cell(stat, delta, rng.uniform(30, 80) * (0.5 if hazard else 1.0))
    spawn = rng.sample(field, N_ENTITIES)          # decision 20: one entity per hex, from tick 0
    ents = [Entity(i, spawn[i], rand_rules(rng, int(START["rules"])))
            for i in range(N_ENTITIES)]
    return {"cells": cells, "ents": ents, "tick": 0, "log": []}

# ---------------------------------------------------------------- naming after the fact (decision 3)
def archetype(e):
    a = e.acts
    if not a:
        return "inert"
    gather, harm, give = a["gather"], a["harm"], a["give"]
    if harm > gather and harm > give:
        return "raider"
    if give > gather and give > harm:
        return "giver"
    if gather:
        return "gatherer"
    return "wanderer"

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

def tune(**kw):
    g = globals()
    for k, v in kw.items():
        assert k in g, k
        g[k] = v

def main(seed=7, show_map=True, quiet=False):
    rng = random.Random(seed)
    world = make_world(rng)
    if not quiet:
        print(f"seed {seed}  {len(world['cells'])} resource cells  {N_ENTITIES} entities\n")
    for t in range(1, TICKS+1):
        run_tick(world, t)
        if quiet:
            if not any(e.alive for e in world["ents"]):
                return {"extinct_at": t, "alive": 0, "world": world}
            continue
        if t % 50 == 0:
            alive = [e for e in world["ents"] if e.alive]
            pop = Counter(archetype(e) for e in alive)
            hp  = sum(e.stat["hp"] for e in alive) / max(1, len(alive))
            print(f"t{t:4d}  alive {len(alive):2d}  mean hp {hp:5.1f}  {dict(pop)}")
            if not alive:
                break

    if quiet:
        return {"extinct_at": None, "alive": sum(1 for e in world["ents"] if e.alive), "world": world}
    print()
    if show_map:
        print(render(world), "\n")
    ents = world["ents"]
    by = defaultdict(list)
    for e in ents:
        by[archetype(e)].append(e.died if e.died is not None else TICKS)
    print("lifespan by emergent archetype (named after the fact):")
    for k, v in sorted(by.items(), key=lambda kv: -sum(kv[1])/len(kv[1])):
        print(f"  {k:9s} n={len(v):2d}  mean life {sum(v)/len(v):6.1f}")
    top = Counter()
    for e in ents:
        for k, v in e.skill.items():
            top[k] = max(top[k], v)
    print("\nhighest skill reached per action type:")
    for k, v in sorted(top.items(), key=lambda kv: -kv[1])[:8]:
        print(f"  {str(k):22s} {v:5.2f}x")

if __name__ == "__main__":
    main()
