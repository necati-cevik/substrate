"""Tick resolution: carry out intents, apply effects, upkeep and death."""
from collections import defaultdict

from .config import (POWER, FALLOFF, K_ABSORB, SKILL_GAIN, SKILL_K,
                     UPKEEP_FLAT, UPKEEP_RATE, STRAIN_DRAIN, SKILL_DECAY,
                     LOOT_PCT, REGROW, START, STATS)
from .hexgrid import hdist, step_towards
from .world import Cell, archetype
from .sense import view_of, resolve_selector
from .flowchart import step_chart
from .display import fmt_sel, fmt_conds, fmt_act

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
    # same frozen world. No copy needed as long as nothing here writes. Each entity steps
    # its chart once (decision 26), collecting every action on the path up to its action
    # budget -- one action per point of effective speed (decision 8 R3, revised by 30).
    intents = []   # (e, act, tgt) -- flattened, one per action
    for e in alive:
        seen_e, seen_c = view_of(e, alive, cells)
        budget = max(1, int(round(e.stat["speed"] * e.condition)))
        actions = step_chart(e, e.chart, seen_e, seen_c, budget)
        if not actions:
            log(e.id, "idle", why="chart reached no action")
            continue
        for act, subject in actions:
            tgt = resolve_selector(e, act[1], seen_e, seen_c, subject)
            intents.append((e, act, tgt))
            if tgt is None:
                # decision 9: bad or missing information wastes the slot, never illegal
                log(e.id, "wasted", act=fmt_act(act),
                    why=("the condition named no target" if act[1][0] == "it"
                         else f"{fmt_sel(act[1])} not perceived"))

    occupancy = defaultdict(list)
    for e in alive:
        occupancy[e.pos].append(e)

    # 4. RESOLVE -- acts land immediately against the frozen snapshot; moves are collected
    # and resolved together below (decision 20).
    moves = defaultdict(list)   # e.id -> [(act, target_cell), ...] in chart order
    for e, act, tgt in intents:
        if tgt is None:
            continue
        kind, pos = tgt
        if act[0] == "move":
            moves[e.id].append((act, pos))
            continue

        d = hdist(e.pos, pos)
        if kind == "source":
            c = cells.get(pos)
            if c is None or c.amount <= 0.01:
                log(e.id, "wasted", act=fmt_act(act), why="source is empty")
                continue
            # a source is its own payload: its (stat, delta) is what you draw and the skill
            # you draw with, so the act names no stat/sign of its own.
            draw = min(c.amount, deliver(e, c.stat, 1 if c.delta > 0 else -1, d))
            c.amount -= draw
            got = absorb(e.stat[c.stat], draw * (1 if c.delta > 0 else -1))
            e.stat[c.stat] += got
            hazard = c.delta < 0
            if not hazard:
                e.strain = max(0.0, e.strain - draw)   # feeding is any draw from the wild
            e.acts["graze_hazard" if hazard else "gather"] += 1
            log(e.id, "hazard" if hazard else "gather", act=fmt_act(act),
                stat=c.stat, drew=round(draw, 2), got=round(got, 2), dist=d,
                target=list(pos), left=round(c.amount, 1), strain=round(e.strain, 2))
        else:
            stat, sign = act[2], act[3]
            raw = deliver(e, stat, sign, d)
            hit = False
            for t in occupancy.get(pos, []):
                if t is e:
                    continue
                hit = True
                if sign < 0:
                    took = absorb(t.stat[stat], raw)               # destruction is free
                    # floor at zero: a negative stat makes deliver() negative, which turns
                    # giving into draining and inverts decision 17
                    t.stat[stat] = max(0.0, t.stat[stat] - took)
                    e.acts["harm"] += 1
                    log(e.id, "harm", act=fmt_act(act), stat=stat, victim=t.id,
                        amount=round(took, 2), dist=d, target=list(pos))
                else:
                    give = min(raw, max(0.0, e.stat[stat]))  # decision 17: creation is funded
                    e.stat[stat] -= give
                    landed = absorb(t.stat[stat], give)
                    t.stat[stat] += landed
                    e.acts["give"] += 1
                    log(e.id, "give", act=fmt_act(act), stat=stat, to_id=t.id,
                        paid=round(give, 2), landed=round(landed, 2), dist=d, target=list(pos))
            if not hit:
                log(e.id, "wasted", act=fmt_act(act), why="cell was empty")
            bump_skill(e, (stat, sign))

    # decision 20: one entity per hex, and a move takes you as close as it can get. Each move
    # action is one hex step toward its own target, so an entity's path is the concatenation
    # of its move actions (decision 30). A contested cell goes to the fastest claimant --
    # effective speed, read off the same frozen snapshot, so there is no turn order in it
    # (R1). A stayer always keeps its own cell, and an exact tie yields for everyone. Each
    # round only shortens a path, so this terminates.
    pos0 = {e.id: e.pos for e in alive}
    pace = {e.id: e.stat["speed"] * e.condition for e in alive}
    path = {e.id: [e.pos] for e in alive}
    at   = dict.fromkeys(pos0, 0)
    for eid, acts in moves.items():
        p = [pos0[eid]]
        for act, pos in acts:
            p.append(step_towards(p[-1], pos, act[2]))
        path[eid], at[eid] = p, len(p) - 1
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

    for e in alive:
        acts = moves.get(e.id)
        if not acts:
            continue
        pth, got, wanted = path[e.id], at[e.id], len(acts)
        target = acts[-1][1]
        if pth[-1] == e.pos:
            # nothing on the map improves on this hex -- arrival, not failure
            e.acts["hold"] += 1
            log(e.id, "hold", frm=list(e.pos), target=list(target),
                dist=hdist(e.pos, target), why="already as close as it can get")
            continue
        if pth[got] == e.pos:
            e.acts["blocked"] += 1
            log(e.id, "blocked", frm=list(e.pos), to=list(pth[-1]),
                target=list(target), why="every hex on the path was taken")
            continue
        frm, e.pos = e.pos, pth[got]
        e.trail.append(e.pos)
        del e.trail[:-8]
        e.acts["move"] += 1
        for act, _ in acts[:got]:
            bump_skill(e, ("position", act[2]))
        log(e.id, "move", frm=list(frm), to=list(e.pos),
            steps=got, wanted=wanted, target=list(target))

    # upkeep (decision 13, amended) + skill decay (decision 15)
    for e in alive:
        # upkeep accrues as strain, proportional to everything you carry -- the tax on
        # the powerful. Strain does two things: it weakens what you do, and it bleeds hp.
        e.strain += UPKEEP_FLAT + UPKEEP_RATE * sum(e.stat[s] for s in STATS)
        e.stat["hp"] -= STRAIN_DRAIN * e.strain
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
