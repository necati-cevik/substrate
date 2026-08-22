"""Entities, resource cells, authored archetypes and world generation."""
import json, os
from collections import defaultdict, Counter

from .config import (MAP_RADIUS, START, START_SPREAD, STRAIN_K, N_ENTITIES, N_BLOBS,
                     RES_WEIGHTS, STATS, CAPPED, HP_AMOUNT, BOON_AMOUNT, UNIT)
from .hexgrid import DIRS, hadd, disc
from .flowchart import chart, parse_chart

# ---------------------------------------------------------------- world
def cell_amount(stat, rng):
    """decision 11 (amended): how much a fresh cell of this stat holds. hp is the staple and
    comes in a heap -- 0 to 10 units, drawn one per act, so a patch is worked over many
    turns and skill decides how fast. Every other stat is a boon, not a larder: exactly one
    unit, taken in a single act, and the cell is spent until the wild grows it back."""
    return float(rng.randint(*HP_AMOUNT)) if stat == "hp" else BOON_AMOUNT

def roll_start(rng):
    """decision 35: no two entities open the same. Each stat is drawn uniformly within
    START_SPREAD of START and in whole units, floored at one: START stays the mean of the
    field and the yardstick everything written against it (corpse loot, authored
    thresholds) still reads true. Whole units are what keeps speed coarse -- a tier is a
    tie in pace (decision 31), and a continuous draw would give every entity a tier of its
    own and quietly delete simultaneous resolution."""
    out = {}
    for s in STATS:
        base, spread = START[s], START_SPREAD.get(s, 0)
        lo = max(UNIT, round(base - spread))
        out[s] = float(rng.randint(int(lo), int(round(base + spread))))
    return out

class Cell:
    """decision 11: a resource cell is the action atom minus the actor."""
    __slots__ = ("stat", "delta", "amount", "cap", "wild")
    def __init__(self, stat, delta, amount, wild=True):
        self.stat, self.delta, self.amount = stat, delta, amount
        self.cap, self.wild = amount, wild

class Entity:
    __slots__ = ("id", "pos", "stat", "max", "skill", "strain", "hunger", "chart", "arch",
                 "born", "died", "acts", "trail")
    def __init__(self, eid, pos, chart, arch="grazer", stat=None):
        self.id, self.pos, self.chart, self.arch = eid, pos, chart, arch
        self.stat  = dict(stat) if stat else dict(START)   # decision 35: rolled, not issued
        # decision 36: the ceiling for every capped stat, which is the roll it opened
        # with. An entity is born full, can be emptied, and can be filled back up to here
        # and no further -- `resolve.run_act` will not put a drop past it, from the wild or
        # from another entity's hands. This is also what `my.max_hp` reads in a threshold
        # (decision 28), so "half my health" is half of a number that is really the top.
        self.max = {s: self.stat[s] for s in CAPPED}
        self.skill = defaultdict(lambda: 1.0)   # (stat, sign) -> percentage modifier
        self.strain = 0.0      # unpaid upkeep. Not a stat: not on the map, not targetable
        self.hunger = 0        # turns since the last draw from the wild -- the clock strain runs on
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

# ---------------------------------------------------------------- archetypes
# Five authored strategies, each a flow chart (decision 26) built from the compact spec
# in flowchart.chart. A turn is one action (decision 31), so every chart has the same
# shape as GRAZE below: branch on distance, act when the target is in reach, step toward
# it when it is not. Chaining two actions in one branch would be dead code -- the walk
# restarts at `start` each tick and never gets past the first one. The `it` selector binds
# to whatever the nearest decision matched, and whenever `other` holds that is the nearest
# entity too, so `dist_entity` below is asking about the same body `other` just read.
#
#   grazer   -- pure economy: avoid hazards, eat what's underfoot, move between patches
#   avoider  -- coward: flee anyone stronger, graze only when no threat is near
#   healer   -- almsgiver: top up the weak out of its own hp, graze otherwise
#   predator -- opportunist: close on the weak and strike, graze when no prey
#   raider   -- aggressor: fight whatever is near, but retreat when badly hurt
# The shared tail: eat food in reach (distance <= 1, decisions 5/20), then
# move to the next patch once this one is spent -- i.e. any +hp source left in sight.
# The `my hp < my.max_hp` is decision 36 showing up in the charts: hp has a ceiling, so
# grazing at full health draws nothing and wastes the turn. Full, the walk falls through to
# the move instead and parks on the patch until hunger has made room again.
# Written out, not assembled (decision 32): the charts read as the strategies they are, and
# `chart` parses them into the tuples the sim walks.
GRAZE = ("decision", "dist +hp source <= 1 and my hp < my.max_hp",
    ("action", "act on +hp source"),
    ("decision", "amount +hp source > 0",
        ("action", "move toward +hp source"),
        ("nothing",)))
ARCHETYPES = {
    "grazer": ("decision", "dist -hp source <= 1",
        ("action", "move away from -hp source"),
        GRAZE),
    "avoider": ("decision", "their hp > 15",
        ("action", "move away from it"),
        ("decision", "dist entity <= 1",
            ("action", "move away from entity"),
            GRAZE)),
    "healer": ("decision", "my hp > 10 and their hp < 8",
        ("decision", "dist entity <= 1",
            ("action", "act +hp on it"),
            ("action", "move toward it")),
        GRAZE),
    "predator": ("decision", "their hp < 10",
        ("decision", "dist entity <= 1",
            ("action", "act -hp on it"),
            ("action", "move toward it")),
        GRAZE),
    "raider": ("decision", "my hp < 8",
        ("action", "move away from entity"),
        ("decision", "dist entity <= 1",
            ("action", "act -hp on entity"),
            ("decision", "dist entity <= 3",
                ("action", "move toward entity"),
                GRAZE))),
}
for _name in ARCHETYPES:
    ARCHETYPES[_name] = chart(ARCHETYPES[_name])

# ---------------------------------------------------------------- behaviour library
# decision 29: the saved charts in `behaviours/` are the library, and the library is what
# entities are born running. Every entity starts on an authored behaviour you can open in
# the editor, diff and edit -- the built-in ARCHETYPES above are only the fallback for a
# world generated with an empty folder.
BEHAVIOUR_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "behaviours")

def raw_behaviours(d=BEHAVIOUR_DIR):
    """{name: authored graph} for every `behaviours/*.json` that is readable JSON, in
    filename order. Unparsed on purpose: this is the library a `behaviour` node's name is
    resolved against (decision 33), so it has to exist before any chart in it is parsed."""
    out = {}
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                out[fn[:-5]] = json.load(f)
        except (OSError, ValueError):
            continue
    return out

def saved_behaviours(d=BEHAVIOUR_DIR):
    """{name: chart} for every `behaviours/*.json` that parses, in filename order. A file
    the sim cannot read or cannot parse is skipped rather than fatal: the folder is edited
    by hand and by the editor, and a half-saved chart must not stop a world from starting.
    Each is parsed against the whole folder, so one chart may call another by name -- and a
    chart whose call cannot be resolved is skipped like any other that will not parse."""
    raw = raw_behaviours(d)
    out = {}
    for name, g in raw.items():
        try:
            out[name] = parse_chart(g, raw)
        except (ValueError, TypeError):
            continue
    return out

# ---------------------------------------------------------------- setup
def make_world(rng, charts=None):
    cells = {}
    field = disc(MAP_RADIUS)
    for _ in range(N_BLOBS):                                   # clustered deltas (decision 11)
        stat   = rng.choices(STATS, weights=RES_WEIGHTS)[0]
        hazard = rng.random() < 0.20
        delta  = rng.uniform(1.5, 3.0) * (-1 if hazard else 1)
        size   = rng.randint(2, 10)                            # islands of 2-10 cells
        starts = [p for p in field if p not in cells]           # no blob overwrites another
        if not starts:
            break
        island = {rng.choice(starts)}
        while len(island) < size:
            border = [hadd(p, d) for p in island for d in DIRS
                      if hadd(p, d) in field and hadd(p, d) not in island
                      and hadd(p, d) not in cells]
            if not border:
                break
            island.add(rng.choice(border))
        for p in island:
            cells[p] = Cell(stat, delta, cell_amount(stat, rng))
    spawn = rng.sample(field, N_ENTITIES)          # decision 20: one entity per hex, from tick 0
    charts = charts or saved_behaviours() or ARCHETYPES
    names = list(charts)
    ents = [Entity(i, spawn[i], charts[names[i % len(names)]], arch=names[i % len(names)],
                   stat=roll_start(rng))
            for i in range(N_ENTITIES)]
    # the rng is kept, not discarded: `random` targets are drawn during the tick
    # (decision 34), and they should come out of the same seeded stream as the map.
    return {"cells": cells, "ents": ents, "tick": 0, "log": [], "rng": rng}

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
