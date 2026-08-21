"""Entities, resource cells, authored archetypes and world generation."""
from collections import defaultdict, Counter

from .config import (MAP_RADIUS, START, STRAIN_K, N_ENTITIES, N_BLOBS,
                     RES_WEIGHTS, PAYLOAD_STATS)
from .hexgrid import DIRS, hadd, disc
from .flowchart import chart

# ---------------------------------------------------------------- world
class Cell:
    """decision 11: a resource cell is the action atom minus the actor."""
    __slots__ = ("stat", "delta", "amount", "cap", "wild")
    def __init__(self, stat, delta, amount, wild=True):
        self.stat, self.delta, self.amount = stat, delta, amount
        self.cap, self.wild = amount, wild

class Entity:
    __slots__ = ("id", "pos", "stat", "skill", "strain", "chart", "arch", "born", "died", "acts", "trail")
    def __init__(self, eid, pos, chart, arch="grazer"):
        self.id, self.pos, self.chart, self.arch = eid, pos, chart, arch
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

# ---------------------------------------------------------------- archetypes
# Five authored strategies, each a flow chart (decision 26) built from the compact spec
# in flowchart.chart. Actions chain through a single continuation, so a chart can move
# and act in one tick -- the budget is the entity's speed, one action per point
# (decision 30). The `it` selector binds to whatever the nearest decision matched.
#
#   grazer   -- pure economy: avoid hazards, eat what's underfoot, move between patches
#   avoider  -- coward: flee anyone stronger, graze only when no threat is near
#   healer   -- almsgiver: top up the weak out of its own hp, graze otherwise
#   predator -- opportunist: close on the weak and strike, graze when no prey
#   raider   -- aggressor: fight whatever is near, but retreat when badly hurt
# The shared tail: eat food underfoot (distance 1 = full reach, decisions 5/20), then
# move to the next patch once this one is spent -- i.e. any +hp source left in sight.
GRAZE = ("decision", [("dist_source", "hp", 1, "<=", 1)],
    ("action", ("act", ("source", "hp", 1))),
    ("decision", [("amount", "hp", 1, ">", 0)],
        ("action", ("move", ("source", "hp", 1), 1)),
        ("end",)))
ARCHETYPES = {
    "grazer": ("decision", [("dist_source", "hp", -1, "<=", 1)],
        ("action", ("move", ("source", "hp", -1), -1)),
        GRAZE),
    "avoider": ("decision", [("other", "hp", ">", 15)],
        ("action", ("move", ("it",), -1)),
        ("decision", [("dist_entity", "<=", 1)],
            ("action", ("move", ("entity",), -1)),
            GRAZE)),
    "healer": ("decision", [("self", "hp", ">", 10), ("other", "hp", "<", 8)],
        ("action", ("act", ("it",), "hp", 1)),
        GRAZE),
    "predator": ("decision", [("other", "hp", "<", 10)],
        ("seq",
            ("action", ("move", ("it",), 1)),
            ("action", ("act", ("it",), "hp", -1))),
        GRAZE),
    "raider": ("decision", [("self", "hp", "<", 8)],
        ("action", ("move", ("entity",), -1)),
        ("decision", [("dist_entity", "<=", 2)],
            ("action", ("act", ("entity",), "hp", -1)),
            GRAZE)),
}
for _name in ARCHETYPES:
    ARCHETYPES[_name] = chart(ARCHETYPES[_name])

# ---------------------------------------------------------------- setup
def make_world(rng):
    cells = {}
    field = disc(MAP_RADIUS)
    for _ in range(N_BLOBS):                                   # clustered deltas (decision 11)
        stat   = rng.choices(PAYLOAD_STATS, weights=RES_WEIGHTS)[0]
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
            cells[p] = Cell(stat, delta, rng.uniform(20, 50))
    spawn = rng.sample(field, N_ENTITIES)          # decision 20: one entity per hex, from tick 0
    names = list(ARCHETYPES)
    ents = [Entity(i, spawn[i], ARCHETYPES[names[i % len(names)]], arch=names[i % len(names)])
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
