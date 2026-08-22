"""Flow-chart behaviour machine (DESIGN.md decision 26).

A behaviour is a small directed graph -- `{entry: <node id>, nodes: {...}}` -- of three
node kinds:

    decision   AND'd conditions -- `yes` / `no` edges
    action     one action -- one `next` edge
    behaviour  runs another named chart, then carries on -- one `next` edge

Each tick the entity begins at the chart's `entry` node and follows edges until one leads
nowhere, carrying out the action nodes on the way -- but only `max_actions` of them, and
that is one (decision 31: one action per tick). The walk picks *which* action: a chart
that reads "if hurt, flee, else eat" spends its turn on whichever branch it lands in, and
anything downstream of that action waits for the next tick.

Charts compose (decision 26/33): a `behaviour` node names another chart in the library and
the walk steps into it, returning to the calling node's `next` when the inner chart ends.
The name is resolved once, at parse time, so a chart in play carries the behaviours it calls
rather than looking them up mid-tick -- and a reference cycle is a parse error, not a hang.
"""
from .rules import COND_SPEC, _parse, _parse_act
from .sense import test_all
from .syntax import parse_cond, parse_conds, parse_act

MAX_NODES = 256   # a malformed chart whose walk never finishes is cut off here;
                  # nested behaviours all spend from this one budget of steps

def step_chart(e, chart, seen_e, seen_c, max_actions=1):
    """Walk `chart` once, returning the list of (act, subject) encountered on the
    path walked, truncated to `max_actions` actions. `subject` is the resolved
    target of the most recent decision whose conditions produced one, so a later `it`
    selector names it (decision 22).

    A `behaviour` node is a call: the walk steps into the chart it names and comes back out
    at that node's `next` when the inner chart ends. One subject and one action budget are
    shared across the whole nesting -- a called behaviour is part of this turn, not another
    one -- while the once-per-walk `seen` set is per chart, so the same behaviour called on
    two branches is not the second call being mistaken for a loop."""
    if not isinstance(chart, dict):
        return []
    nodes, cur = chart.get("nodes") or {}, chart.get("entry")
    out, subject = [], None
    seen, frames = set(), []          # frames: charts walked into, and where to resume
    for _ in range(MAX_NODES):
        # off the end of this chart -- an edge to nowhere, or a node this walk has already
        # passed. Return to whoever called it; at the top, the walk is over.
        while not cur or cur not in nodes or cur in seen:
            if not frames:
                return out
            nodes, seen, cur = frames.pop()
        seen.add(cur)
        n = nodes[cur]
        t = n.get("type")
        if t == "action":
            if len(out) >= max_actions:
                return out
            out.append((n.get("act"), subject))
            cur = n.get("next")
        elif t == "decision":
            ok, sub = test_all(e, n.get("conds") or [], seen_e, seen_c)
            if sub is not None:
                subject = sub
            cur = n.get("yes") if ok else n.get("no")
        elif t == "behaviour":
            frames.append((nodes, seen, n.get("next")))
            inner = n.get("chart") or {}
            nodes = inner.get("nodes") or {}
            seen, cur = set(), inner.get("entry")
        else:
            cur = n.get("next")
    return out

def _conds(v, what):
    """A decision's test, however it was written: text (one condition per line or joined
    by `and`), a list of written conditions, or the tuples themselves (decision 32). The
    written form is a surface over the same grammar, so all three end up identical."""
    if isinstance(v, str):
        return parse_conds(v)
    if not isinstance(v, (list, tuple)) or not v:
        raise ValueError(f"{what}: needs conditions")
    return tuple(parse_cond(c) if isinstance(c, str)
                 else _parse(COND_SPEC, c, f"{what} condition {j}")
                 for j, c in enumerate(v))

def _act(v, what):
    if isinstance(v, str):
        return parse_act(v)
    return _parse_act(v)

def _edge(ref, ids):
    if ref is None or ref == "":
        return ""
    if not isinstance(ref, str) or ref not in ids:
        raise ValueError(f"edge {ref!r} does not name a node")
    return ref

def _called(name, lib, stack, cache, what):
    """Resolve a `behaviour` node's name against the library and parse what it names, so a
    parsed chart carries the charts it calls (decision 33). `stack` is the chain of names
    being resolved, which is how a chart that would end up running itself is caught here
    rather than at walk time; `cache` keeps a chart called from two places parsed once."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"{what}: needs the name of a behaviour to run")
    name = name.strip()
    if name in stack:
        raise ValueError(f"{what}: {name!r} would run itself "
                         f"({' -> '.join(stack + (name,))})")
    if not isinstance(lib, dict) or name not in lib:
        raise ValueError(f"{what}: no behaviour named {name!r} in the library")
    if name not in cache:
        cache[name] = parse_chart(lib[name], lib, stack + (name,), cache)
    return name, cache[name]

def parse_chart(graph, lib=None, _stack=(), _cache=None):
    """Validate an authored chart off the wire and normalise its conditions/actions.
    Raises ValueError on any malformed node, edge or grammar item (decision 9 is about
    bad information inside the sim, not about letting malformed charts into it).

    `lib` is {name: authored graph} -- the behaviour library a `behaviour` node's name is
    looked up in. Passing none is the same as passing an empty one: a chart that calls
    nothing parses either way, and a chart that calls something says so."""
    _cache = {} if _cache is None else _cache
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), dict) or not graph["nodes"]:
        raise ValueError("chart must be {entry: ..., nodes: {...}}")
    nodes = graph["nodes"]
    entry = graph.get("entry")
    if not isinstance(entry, str) or entry not in nodes:
        raise ValueError("chart needs an `entry` naming the node its walk begins at")
    ids = set(nodes)
    out = {}
    for k, n in nodes.items():
        if not isinstance(n, dict) or "type" not in n:
            raise ValueError(f"node {k!r}: not a typed object")
        t = n["type"]
        if t == "decision":
            out[k] = {"type": "decision",
                      "conds": _conds(n.get("conds"), f"decision {k!r}"),
                      "yes": _edge(n.get("yes"), ids),
                      "no": _edge(n.get("no"), ids)}
        elif t == "action":
            if "act" not in n:
                raise ValueError(f"action {k!r}: needs an act")
            out[k] = {"type": "action", "act": _act(n["act"], f"action {k!r}"),
                      "next": _edge(n.get("next"), ids)}
        elif t == "behaviour":
            nm, sub = _called(n.get("name"), lib, _stack, _cache, f"behaviour {k!r}")
            out[k] = {"type": "behaviour", "name": nm, "chart": sub,
                      "next": _edge(n.get("next"), ids)}
        else:
            raise ValueError(f"node {k!r}: unknown type {t!r}")
    return {"entry": entry, "nodes": out}

def chart(spec):
    """Build a chart dict from a compact nested spec (used for the authored archetypes):

        ('action', act)                          an action node
        ('decision', conds, yes_spec, no_spec)   a decision with yes/no subgraphs
        ('nothing',)                             spend no action on this branch

    Conditions and actions may be written (decision 32) or given as tuples; either way the
    nodes come out parsed, since the sim walks tuples.

    There is no way to sequence two actions, because there is no such thing: a turn is one
    action (decision 31) and the walk restarts at the entry next tick, so anything after the
    first action on a path would never run. Sequencing is expressed as a decision instead
    -- "in reach? act : step closer"."""
    nodes, seq = {}, [0]
    def new(t, **kw):
        seq[0] += 1
        nid = f"n{seq[0]}"
        nodes[nid] = {"type": t, **kw}
        return nid
    def build(s, cont):
        k = s[0]
        if k == "action":
            return new("action", act=_act(s[1], "action"), next=cont)
        if k == "decision":
            return new("decision", conds=_conds(s[1], "decision"),
                       yes=build(s[2], cont), no=build(s[3], cont))
        if k == "nothing":
            return cont
        raise ValueError(f"unknown chart step {k!r}")
    return {"entry": build(spec, ""), "nodes": nodes}
