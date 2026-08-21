"""Flow-chart behaviour machine (DESIGN.md decision 26).

A behaviour is a small directed graph:

    start     entry point -- one `next` edge
    decision  AND'd conditions -- `yes` / `no` edges
    action    one action -- one `next` edge
    end       terminal

Each tick the entity begins at `start` and follows edges until it reaches an `end`,
carrying out every action node on the way -- up to `max_actions`, its action budget
(decision 8 R3 as revised by decision 30: speed is the number of actions per tick).
A chart can therefore move toward a target and act on it in the same turn.
"""
from .rules import COND_SPEC, _parse, _parse_act
from .sense import test_all

MAX_NODES = 64    # a malformed chart that never reaches an end is cut off here

def step_chart(e, chart, seen_e, seen_c, max_actions):
    """Walk `chart` once, returning the list of (act, subject) encountered on the
    start->end path, truncated to `max_actions` actions. `subject` is the resolved
    target of the most recent decision whose conditions produced one, so a later `it`
    selector names it (decision 22)."""
    nodes = chart.get("nodes", {}) if isinstance(chart, dict) else {}
    start = next((k for k, n in nodes.items()
                  if isinstance(n, dict) and n.get("type") == "start"), None)
    if start is None:
        return []
    out, subject = [], None
    cur = nodes[start].get("next")
    seen = set()
    for _ in range(MAX_NODES):
        if not cur or cur not in nodes or cur in seen:
            break
        seen.add(cur)
        n = nodes[cur]
        t = n.get("type")
        if t == "end":
            break
        if t == "action":
            if len(out) >= max_actions:
                break
            out.append((n.get("act"), subject))
            cur = n.get("next")
        elif t == "decision":
            ok, sub = test_all(e, n.get("conds") or [], seen_e, seen_c)
            if sub is not None:
                subject = sub
            cur = n.get("yes") if ok else n.get("no")
        else:
            cur = n.get("next")
    return out

def _edge(ref, ids):
    if ref is None or ref == "":
        return ""
    if not isinstance(ref, str) or ref not in ids:
        raise ValueError(f"edge {ref!r} does not name a node")
    return ref

def parse_chart(graph):
    """Validate an authored chart off the wire and normalise its conditions/actions.
    Raises ValueError on any malformed node, edge or grammar item (decision 9 is about
    bad information inside the sim, not about letting malformed charts into it)."""
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), dict) or not graph["nodes"]:
        raise ValueError("chart must be {nodes: {...}}")
    nodes = graph["nodes"]
    starts = [k for k, n in nodes.items() if isinstance(n, dict) and n.get("type") == "start"]
    if len(starts) != 1:
        raise ValueError("chart needs exactly one start node")
    ids = set(nodes)
    out = {}
    for k, n in nodes.items():
        if not isinstance(n, dict) or "type" not in n:
            raise ValueError(f"node {k!r}: not a typed object")
        t = n["type"]
        if t == "start":
            out[k] = {"type": "start", "next": _edge(n.get("next"), ids)}
        elif t == "end":
            out[k] = {"type": "end"}
        elif t == "decision":
            conds = n.get("conds")
            if not isinstance(conds, (list, tuple)) or not conds:
                raise ValueError(f"decision {k!r}: needs conditions")
            out[k] = {"type": "decision",
                      "conds": tuple(_parse(COND_SPEC, c, f"node {k} condition {j}")
                                     for j, c in enumerate(conds)),
                      "yes": _edge(n.get("yes"), ids),
                      "no": _edge(n.get("no"), ids)}
        elif t == "action":
            if "act" not in n:
                raise ValueError(f"action {k!r}: needs an act")
            out[k] = {"type": "action", "act": _parse_act(n["act"]),
                      "next": _edge(n.get("next"), ids)}
        else:
            raise ValueError(f"node {k!r}: unknown type {t!r}")
    return {"nodes": out}

def chart(spec):
    """Build a chart dict from a compact nested spec (used for the authored archetypes):

        ('action', act)                          an action node
        ('decision', conds, yes_spec, no_spec)   a decision with yes/no subgraphs
        ('seq', *specs)                          run specs one after another
        ('end',)                                 do nothing, continue

    Each subgraph threads a single continuation, so `('seq', move, act)` is exactly
    "move, then act" in one tick (budget permitting)."""
    nodes, seq = {}, [0]
    def new(t, **kw):
        seq[0] += 1
        nid = f"n{seq[0]}"
        nodes[nid] = {"type": t, **kw}
        return nid
    def build(s, cont):
        k = s[0]
        if k == "action":
            return new("action", act=s[1], next=cont)
        if k == "decision":
            return new("decision", conds=s[1],
                       yes=build(s[2], cont), no=build(s[3], cont))
        if k == "seq":
            for item in reversed(s[1:]):
                cont = build(item, cont)
            return cont
        if k == "end":
            return cont
        raise ValueError(f"unknown chart step {k!r}")
    end = new("end")
    nodes["start"] = {"type": "start", "next": build(spec, end)}
    return {"nodes": nodes}
