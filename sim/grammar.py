"""Rule grammar: condition/action vocabulary, random generation, editor schemas."""
from .config import STATS, START

# ---------------------------------------------------------------- rule grammar (decision 16)
# condition: what the model already contains, nothing more
#   ("self", stat, op, v) | ("other", stat, op, v) | ("dist_entity", op, v)
#   ("dist_source", stat, op, v) | ("count_entity", op, v) | ("always",)
# a rule holds a list of conditions, all of which must hold (AND).
# action:
#   ("move", selector, sign) | ("act", selector, stat, sign)
# selector: ("entity",) | ("source", stat, sign) | ("it",) | ("random",)  -- decisions 22, 34

OPS = {"<": lambda a, b: a < b, ">": lambda a, b: a > b,
       "<=": lambda a, b: a <= b, ">=": lambda a, b: a >= b}

def rand_op(rng):
    """decision 16: a comparator, drawn uniformly from the full set -- >= and <=
    included, so random rules are no blinder than the ones you can write by hand."""
    return rng.choice(list(OPS))

def rand_selector(rng):
    k = rng.random()
    if k < 0.10:
        return ("random",)          # decision 34: a hex, not a thing -- mostly worth moving to
    if k < 0.45:
        return ("entity",)
    return ("source", rand_stat(rng), 1 if rng.random() < 0.8 else -1)

def rand_stat(rng):
    """A stat to read, test, offer or trade. Decision 27: every stat plays every role, so
    one draw serves them all -- weighted toward hp, which is what the wild mostly carries."""
    return rng.choices(STATS, weights=[5, 2, 2])[0]

def rand_condition(rng):
    k = rng.random()
    if k < 0.30:
        s = rand_stat(rng)
        return ("self", s, rand_op(rng), round(START[s] * rng.uniform(0.3, 1.1), 2))
    if k < 0.42:
        s = rand_stat(rng)
        return ("other", s, rand_op(rng), round(START[s] * rng.uniform(0.3, 1.1), 2))
    if k < 0.60:
        return ("dist_entity", rand_op(rng), rng.randint(1, 6))
    if k < 0.85:
        return ("dist_source", rand_stat(rng), 1 if rng.random() < 0.8 else -1,
                rand_op(rng), rng.randint(1, 6))
    if k < 0.93:
        return ("count_entity", rand_op(rng), rng.randint(1, 4))
    return ("amount", rand_stat(rng), 1 if rng.random() < 0.8 else -1,
            rand_op(rng), rng.randint(2, 20))

def rand_action(rng):
    sel = rand_selector(rng)
    if rng.random() < 0.45:
        return ("move", sel, 1 if rng.random() < 0.75 else -1)
    if sel[0] == "source":
        return ("act", sel)                                   # gathering: the source carries its own payload
    return ("act", sel, rand_stat(rng), 1 if rng.random() < 0.35 else -1)

def action_source(act):
    """The (stat, sign) a rule's action acts on, if its selector names a source."""
    sel = act[1]
    return (sel[1], sel[2]) if sel[0] == "source" else None

def source_exists_condition(rng, stat, sign):
    """A condition that is false while no such source is perceived, so an action on a
    source is not tried blind (decision 9: a missing source would waste the slot)."""
    if rng.random() < 0.5:
        return ("dist_source", stat, sign, rand_op(rng), rng.randint(1, 6))
    return ("amount", stat, sign, ">", rng.randint(2, 20))

def rand_rules(rng, n):
    """Semi-random: n-1 random rules, then a guaranteed fallback so nobody is inert.
    A rule whose action names a source also carries a condition confirming that source
    exists, so it never fires on a source it cannot perceive."""
    rules = []
    for _ in range(n - 1):
        act = rand_action(rng)
        conds = [rand_condition(rng)]
        src = action_source(act)
        if src is not None:
            conds.append(source_exists_condition(rng, *src))
        rules.append((conds, act))
    # eat from the nearest food -- but only if any is perceived, else this wastes the slot too.
    # (A move here would only walk onto the patch and stand on it; an act actually draws it.)
    rules.append(([("amount", "hp", 1, ">", 0)], ("act", ("source", "hp", 1))))
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
# The full (entity/it) arity. An act on a source is narrower -- it names no stat/sign,
# because the source carries them -- so it is parsed by _parse_act, not _parse.
ACT_SPEC = {
    "move": ["sel", "sign"],
    "act":  ["sel", "stat", "sign"],
}
SEL_SPEC = {
    "entity": [],
    "source": ["stat", "sign"],
    "it":     [],                # decision 22: whatever the condition matched
    "random": [],                # decision 34: a hex next to you, drawn fresh each tick
}
