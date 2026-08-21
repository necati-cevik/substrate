"""Substrate sim -- first runnable version of DESIGN.md.

In:  hex arena, clustered resource deltas, entities running 3-4 if/do rules,
     reach attenuation, absorption, upkeep decay, skill, corpse loot, death.
Out: genes, karma, rebirth, reproduction, environment actions. Deferred on purpose.

The package is split by concern (config, hexgrid, world, grammar, rules, sense,
resolve, display); this module re-exports the public surface and provides the CLI
entry point.
"""
import random
from collections import defaultdict, Counter

from .config import (MAP_RADIUS, N_ENTITIES, TICKS, STATS,
                     K_ABSORB, FALLOFF, UPKEEP_FLAT, UPKEEP_RATE,
                     STRAIN_K, STRAIN_DRAIN, LOOT_PCT, SKILL_GAIN,
                     SKILL_DECAY, REGROW, READ_FRAC)
from .hexgrid import DIRS, hdist, hadd, disc, step_towards
from .world import Cell, Entity, archetype, make_world, GRAZE, ARCHETYPES
from .grammar import OPS, COND_SPEC, ACT_SPEC, SEL_SPEC, rand_rules
from .rules import parse_ruleset
from .flowchart import step_chart, parse_chart, chart
from .sense import read_radius
from .resolve import run_tick
from .display import render, fmt_sel, fmt_cond, fmt_conds, fmt_act


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
