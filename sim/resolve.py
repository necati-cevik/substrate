"""Tick resolution: carry out intents, apply effects, upkeep and death."""
import random as _random
from collections import Counter, defaultdict

from .config import (POWER, K_ABSORB, SKILL_GAIN, SKILL_K, ACTS_PER_TICK,
                     UPKEEP_FLAT, UPKEEP_RATE, SKILL_DECAY, LOOT_PCT, REGROW,
                     HUNGER_GRACE, HUNGER_EXP, HUNGER_DRAIN, UNIT, START, STATS)
from .hexgrid import hdist, step_towards
from .world import Cell, archetype
from .sense import view_of, resolve_selector
from .flowchart import step_chart
from .display import fmt_sel, fmt_conds, fmt_act

REACH = 1   # decision 5: an act lands on your own cell or a neighbour, and nowhere else

# ---------------------------------------------------------------- resolution
def deliver(e, stat, sign):
    """decisions 31 + 15 + 13: one flat unit, scaled by skill and by condition. There is no
    distance term -- reach is adjacency (decision 5), so an act either reaches or it does
    not, and inside reach every act is worth the same."""
    return POWER * e.skill[(stat, sign)] * e.condition

def absorb(target_level, raw):
    """decision 12."""
    return raw / (1 + K_ABSORB * max(0.0, target_level))

def headroom(t, stat):
    """decision 36: how much more of this stat `t` can be made to hold. A stat with no
    ceiling has no limit; a capped one can be filled to the roll it was born at and no
    further, by any hand -- the wild's or another entity's."""
    cap = t.max.get(stat)
    return float("inf") if cap is None else max(0.0, cap - t.stat[stat])

def upto(head, paid, landed):
    """The pair (paid, landed) trimmed so `landed` fits in `head`.

    The cap is enforced on the way in, not by clipping afterwards, so nothing is destroyed
    to make it hold: a grazer at nine-tenths health takes a tenth of a unit out of the
    patch and leaves the rest in the ground, and a healer topping up a nearly-full target
    spends only what actually lands. Clipping `t.stat` instead would have the overflow
    vanish -- the cell emptied, the giver's hp gone, and nobody the better for it.

    `paid` is what leaves the source, `landed` what arrives after absorption (decision 12);
    they are not the same number, so the trim is a ratio rather than a subtraction."""
    if landed <= head:
        return paid, landed
    if landed <= 0:
        return 0.0, 0.0
    return paid * (head / landed), head

def bite(hunger):
    """decision 13 (amended): how hard this turn of hunger presses, as a multiplier.

    Upkeep is owed every turn but not collected every turn. The first HUNGER_GRACE turns
    after a meal cost nothing at all -- an entity that draws from the wild every few turns
    never pays, which is what makes a boon cell worth a detour: a speed+ cell holds one
    unit and no food, yet taking it puts the clock back to zero exactly like a meal does.
    Past the grace the bite grows by a constant factor each turn, so neglect is cheap for
    a while and then very suddenly is not."""
    n = hunger - HUNGER_GRACE
    return HUNGER_EXP ** (n - 1) if n > 0 else 0.0

def run_tick(world, tick):
    ents, cells = world["ents"], world["cells"]
    # the world's own rng, so a seeded world stays reproducible even now that a chart can
    # ask for a random hex (decision 34). A world made without one falls back to the module.
    rng = world.get("rng") or _random
    alive = [e for e in ents if e.alive]
    ev = []
    def log(eid, kind, **kw):
        ev.append(dict(t=tick, e=eid, kind=kind, **kw))

    # 1. SNAPSHOT + 2. SENSE + 3. DECIDE
    # R1: decisions are all computed before any mutation below, so every entity reads the
    # same frozen world. No copy needed as long as nothing here writes. Each entity walks
    # its chart until it reaches its first action, and that action is its whole turn
    # (decision 31: one action per tick, magnitude one).
    intents = []   # (e, act, tgt) -- at most one per entity
    for e in alive:
        seen_e, seen_c = view_of(e, alive, cells)
        actions = step_chart(e, e.chart, seen_e, seen_c, ACTS_PER_TICK)
        if not actions:
            log(e.id, "idle", why="chart reached no action")
            continue
        act, subject = actions[0]
        tgt = resolve_selector(e, act[1], seen_e, seen_c, subject, rng)
        if tgt is None:
            # decision 9: bad or missing information wastes the turn, never illegal
            log(e.id, "wasted", act=fmt_act(act),
                why=("the condition named no target" if act[1][0] == "it"
                     else f"{fmt_sel(act[1])} not perceived"))
            continue
        intents.append((e, act, tgt))

    # 4. RESOLVE -- fastest first (decision 31). Everyone decided blind against the same
    # snapshot, but effects land in order of effective speed: equal pace is one tier and
    # resolves simultaneously, and each tier sees what the tiers above it did. So a fleer
    # quicker than its attacker is out of the hex before the blow arrives, and the blow
    # lands on empty ground. Strain is in the pace, so a worn-down entity acts late.
    occ = {e.pos: e for e in alive}          # decision 20: one entity per hex
    pace = {e.id: e.stat["speed"] * e.condition for e in alive}
    tiers = defaultdict(list)
    for e, act, tgt in intents:
        tiers[pace[e.id]].append((e, act, tgt))

    for p in sorted(tiers, reverse=True):
        tier = tiers[p]
        # Within a tier acts come before moves: nothing separates them in time, so you
        # strike the body that is standing there as the tier opens.
        for e, act, tgt in tier:
            if act[0] != "move":
                run_act(e, act, tgt, cells, occ, log)
        run_moves([t for t in tier if t[1][0] == "move"], alive, occ, log)

    # upkeep (decision 13, amended) + skill decay (decision 15)
    for e in alive:
        # Hunger is the clock upkeep runs on: one turn older for everyone, reset to zero
        # by any draw from the wild (run_act). While it is inside the grace nothing is
        # collected; past it the same bite drives two separate effects -- strain, which
        # weakens what you do, and a bleed, which kills you. Strain is still proportional
        # to everything you carry, the tax on the powerful; the bleed is flat, because
        # starving does not care how strong you were.
        e.hunger += 1
        b = bite(e.hunger)
        if b:
            e.strain += (UPKEEP_FLAT + UPKEEP_RATE * sum(e.stat[s] for s in STATS)) * b
            e.stat["hp"] -= HUNGER_DRAIN * b
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

# ---------------------------------------------------------------- one act, one move
def run_act(e, act, tgt, cells, occ, log):
    """One non-move action, resolved against the world as it stands in this speed tier."""
    kind, pos = tgt
    d = hdist(e.pos, pos)
    if d > REACH:
        # decision 5: reach is adjacency. Distance does not attenuate, it excludes.
        log(e.id, "wasted", act=fmt_act(act), dist=d, target=list(pos),
            why=f"out of reach (d{d})")
        return
    if kind == "source":
        c = cells.get(pos)
        if c is None or c.amount < UNIT:
            log(e.id, "wasted", act=fmt_act(act), why="source is empty",
                left=round(c.amount, 2) if c else 0)
            return
        # a source is its own payload: its (stat, delta) is what you draw and the skill
        # you draw with, so the act names no stat/sign of its own.
        sign = 1 if c.delta > 0 else -1
        draw = min(c.amount, deliver(e, c.stat, sign))
        got = absorb(e.stat[c.stat], draw * sign)
        if sign > 0:
            # decision 36: you cannot draw what you have nowhere to put. A hazard is not
            # trimmed -- there is no ceiling on being emptied, only on being filled.
            head = headroom(e, c.stat)
            if head <= 0:
                log(e.id, "wasted", act=fmt_act(act), stat=c.stat, dist=d, target=list(pos),
                    why=f"already at full {c.stat} ({round(e.max[c.stat], 1)})")
                return
            draw, got = upto(head, draw, got)
        c.amount -= draw
        e.stat[c.stat] += got
        hazard = c.delta < 0
        if not hazard:
            # feeding is any draw from the wild, whatever stat it was for: it puts the
            # hunger clock back to zero and pays down what strain already accrued.
            e.hunger = 0
            e.strain = max(0.0, e.strain - draw)
        e.acts["graze_hazard" if hazard else "gather"] += 1
        log(e.id, "hazard" if hazard else "gather", act=fmt_act(act),
            stat=c.stat, drew=round(draw, 2), got=round(got, 2), dist=d,
            target=list(pos), left=round(c.amount, 1), strain=round(e.strain, 2),
            hunger=e.hunger, skill=round(e.skill[(c.stat, sign)], 2))
        # decision 15: drawing is an action type like any other, so it trains. This is what
        # "one unit at a time" leaves room for -- a practised gatherer lifts more than a
        # unit per act, and works a patch out faster than a novice standing on the same hex.
        bump_skill(e, (c.stat, sign))
        return

    stat, sign = act[2], act[3]
    raw = deliver(e, stat, sign)
    t = occ.get(pos)
    if t is None or t is e:
        log(e.id, "wasted", act=fmt_act(act), dist=d, target=list(pos),
            why="cell was empty")
    elif sign < 0:
        took = absorb(t.stat[stat], raw)                   # destruction is free
        # floor at zero: a negative stat makes deliver() negative, which turns giving
        # into draining
        t.stat[stat] = max(0.0, t.stat[stat] - took)
        e.acts["harm"] += 1
        log(e.id, "harm", act=fmt_act(act), stat=stat, victim=t.id,
            amount=round(took, 2), dist=d, target=list(pos))
    else:
        # decision 36: a full target cannot be topped up, and the giver keeps what would
        # only have spilled -- charity into a ceiling costs nobody anything.
        head = headroom(t, stat)
        if head <= 0:
            log(e.id, "wasted", act=fmt_act(act), stat=stat, victim=t.id, dist=d,
                target=list(pos), why=f"e{t.id} is already at full {stat} "
                                      f"({round(t.max[stat], 1)})")
            return
        give = min(raw, max(0.0, e.stat[stat]))
        give, landed = upto(head, give, absorb(t.stat[stat], give))
        e.stat[stat] -= give
        t.stat[stat] += landed
        e.acts["give"] += 1
        log(e.id, "give", act=fmt_act(act), stat=stat, to_id=t.id,
            paid=round(give, 2), landed=round(landed, 2), dist=d, target=list(pos))
    bump_skill(e, (stat, sign))


def run_moves(tier, alive, occ, log):
    """Every move in one speed tier, resolved together (decision 20, 31).

    A move is a single hex. A destination is free unless somebody is standing in it who is
    not vacating it in this same tier -- entities in slower tiers have not moved yet, so
    they are still walls. Two movers in one tier wanting the same hex both yield, which is
    decision 20's exact tie: the fastest claimant already won by being in an earlier tier."""
    dest = {}
    for e, act, tgt in tier:
        dest[e.id] = (e, act, tgt[1], step_towards(e.pos, tgt[1], act[2]))
    claims = Counter(d for _, _, _, d in dest.values())

    # Who is blocked settles by iteration, not in one pass: a mover only vacates its hex if
    # it actually goes, so one entity that yields is still standing where it was, and that
    # makes its hex a wall for whoever was stepping into it -- which can block them in turn.
    # Blocking one entity never frees a hex, so this only ever grows and always settles.
    blocked = {e.id: "another entity claimed it at the same speed"
               for e, _, _, d in dest.values() if d != e.pos and claims[d] > 1}
    while True:
        staying = {o.pos for o in alive
                   if o.id not in dest or o.id in blocked or dest[o.id][3] == o.pos}
        stuck = [e.id for e, _, _, d in dest.values()
                 if e.id not in blocked and d != e.pos and d in staying]
        if not stuck:
            break
        blocked.update(dict.fromkeys(stuck, "that hex is taken"))

    winners = []
    for e, act, target, d in dest.values():
        if d == e.pos:
            # nothing on the map improves on this hex -- arrival, not failure
            e.acts["hold"] += 1
            log(e.id, "hold", frm=list(e.pos), target=list(target),
                dist=hdist(e.pos, target), why="already as close as it can get")
        elif e.id in blocked:
            e.acts["blocked"] += 1
            log(e.id, "blocked", frm=list(e.pos), to=list(d), target=list(target),
                why=blocked[e.id])
        else:
            winners.append((e, act, target, d))

    for e, _, _, _ in winners:            # vacate first, so a chain of movers does not
        del occ[e.pos]                    # delete the hex its neighbour just stepped into
    for e, _, target, d in winners:
        frm, e.pos = e.pos, d
        occ[d] = e
        e.trail.append(d)
        del e.trail[:-8]
        e.acts["move"] += 1
        # a move trains nothing: it is one hex whoever takes it (decision 31), so there is
        # no magnitude for skill to scale and nothing for practice to sharpen.
        log(e.id, "move", frm=list(frm), to=list(d), target=list(target),
            dist=hdist(d, target))


def bump_skill(e, key):
    e.skill[key] += SKILL_GAIN / (1 + SKILL_K * (e.skill[key] - 1.0))
