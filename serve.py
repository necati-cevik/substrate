"""Browser front end for the sim package. Stdlib only -- decision 18.

    python3 serve.py [port] [seed]     then open http://localhost:8000
"""
import copy, json, os, random, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import sim

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_CAP = 4000
HIST_CAP = 600      # how many ticks back a turn can be replayed from

STATE = {"world": None, "seed": 7, "log": [], "hist": []}

# ---------------------------------------------------------------- replay
# A turn can be walked back to and run again, and what comes back is the *whole* world as
# it stood at the end of that tick -- every cell's amount, every entity's position, stats,
# ceilings, skill, strain, hunger and trail, and the rng itself. Nothing is recomputed and
# nothing is patched up from the log: the state is kept, so a replayed turn is the turn,
# not a reconstruction of it that can drift from what the sim actually did.
def _freeze(world):
    """A deep copy of the world. Charts are shared rather than copied -- a chart in play is
    never mutated (authoring replaces the attribute, `/api/rules`), and copying every
    entity's chart every tick would dwarf the state that actually moves."""
    memo = {}
    for e in world["ents"]:
        if e.chart is not None:
            memo[id(e.chart)] = e.chart
    return copy.deepcopy(world, memo)

def _remember():
    h = STATE["hist"]
    h.append((STATE["world"]["tick"], _freeze(STATE["world"])))
    del h[:-HIST_CAP]

def _fork():
    """The world has been walked back and is about to run on. Whatever was recorded after
    this tick belongs to a run that no longer exists -- a chart may have been authored in
    the meantime -- so the future is dropped rather than left to contradict the new one."""
    t = STATE["world"]["tick"]
    STATE["hist"] = [s for s in STATE["hist"] if s[0] <= t]
    STATE["log"] = [v for v in STATE["log"] if v["t"] <= t]

def span():
    """The ticks that can be replayed: the oldest one still kept, and the furthest reached."""
    h = STATE["hist"]
    return (h[0][0], h[-1][0]) if h else (0, 0)

def goto(t):
    """Put the world back the way it was at the end of tick `t`. The copy is taken *out* of
    the record, not handed over, so running on from here leaves the recorded turn intact and
    you can walk back to it again."""
    h = STATE["hist"]
    if not h:
        return
    t = max(h[0][0], min(h[-1][0], t))
    snap = next(s for s in reversed(h) if s[0] <= t)
    STATE["world"] = _freeze(snap[1])

def reset(seed):
    STATE["seed"] = seed
    STATE["world"] = sim.make_world(random.Random(seed))
    STATE["log"] = []
    STATE["hist"] = []
    _remember()                      # tick 0 is a turn you can come back to like any other

def advance(n):
    """Run the world on -- or, when it has been walked back, play the recorded turns again
    before running past them. Re-running them would come out the same (the rng is part of
    what was kept), so the only difference is that replaying keeps the record: walking back,
    stepping forward and walking back again lands on the same turns rather than burning the
    future each time. Authoring a chart is what invalidates the record, and forks it there."""
    w = STATE["world"]
    for _ in range(n):
        if w["tick"] < span()[1]:
            goto(w["tick"] + 1)
            w = STATE["world"]
            continue
        if not any(e.alive for e in w["ents"]):
            break
        STATE["log"] += sim.run_tick(w, w["tick"] + 1)
        _remember()
    del STATE["log"][:-LOG_CAP]

def grammar():
    """The condition/action vocabulary as data (decision 26's schema, sim/grammar.py), plus
    the starting stats an authored threshold is read against -- `start` is the mean of the
    opening roll and `spread` how far either side of it an entity can be born (decision 35),
    so the UI knows the top of the range a stat bar has to hold. `capped` is the stats with
    a ceiling (decision 36) -- the ones a threshold may write `my.max_<stat>` for, and the
    ones a bar is drawn against the entity's own maximum rather than the field's range."""
    return {"cond": sim.COND_SPEC, "act": sim.ACT_SPEC, "sel": sim.SEL_SPEC,
            "stats": sim.STATS, "ops": list(sim.OPS), "start": dict(sim.START),
            "spread": dict(sim.START_SPREAD), "capped": list(sim.CAPPED),
            "acts_per_tick": sim.ACTS_PER_TICK}

def snapshot(log_tail=600, log_ahead=600):
    w = STATE["world"]
    # sub-unit cells are still sent: they are visible ground that is part-way to ripe,
    # and `ripe` is what says whether anything can actually be drawn from one (sim.UNIT).
    cells = [{"q": p[0], "r": p[1], "stat": c.stat, "delta": round(c.delta, 2),
              "amount": round(c.amount, 1), "cap": round(c.cap, 1), "wild": c.wild,
              "ripe": c.amount >= sim.UNIT}
             for p, c in w["cells"].items() if c.amount > 0.05]
    ents = []
    for e in w["ents"]:
        ents.append({
            "id": e.id, "q": e.pos[0], "r": e.pos[1], "alive": e.alive, "died": e.died,
            "arch": e.arch,
            "stat": {k: round(v, 2) for k, v in e.stat.items()},
            "max": {k: round(v, 2) for k, v in e.max.items()},   # decision 36: its ceilings
            "strain": round(e.strain, 2), "condition": round(e.condition, 3),
            "hunger": e.hunger, "bite": round(sim.bite(e.hunger + 1), 2),
            "read": sim.read_radius(e),      # decision 23: half sense, where stats become legible
            "skill": sorted(([f"{k[0]} {'+' if k[1] > 0 else '-'}", round(v, 2)]
                             for k, v in e.skill.items()), key=lambda x: -x[1]),
            "chart": e.chart,
            "trail": [[p[0], p[1]] for p in e.trail],
            "acts": dict(e.acts), "archetype": sim.archetype(e),
        })
    # The log is a window on the run centred on the tick being shown, not a tail of it:
    # walked back, what you want to read is the turns around the one you are looking at, and
    # the turns that came after are still part of the run -- the world has been put back into
    # an earlier moment, the record of what happened has not been unwritten. (The one thing
    # that does unwrite it is authoring a chart, `_fork`: those turns will not happen now.)
    # Symmetric, so walking back does not cost you the far side of the window: at the head
    # of the run there is nothing ahead and the payload is the tail it always was.
    cut = sum(1 for v in STATE["log"] if v["t"] <= w["tick"])
    evs = STATE["log"][max(0, cut - log_tail):cut + log_ahead]
    first, head = span()
    return {"tick": w["tick"], "radius": sim.MAP_RADIUS, "seed": STATE["seed"],
            "cells": cells, "ents": ents, "events": evs,
            "first": first, "head": head,   # the replayable span (decision 37)
            "alive": sum(1 for e in w["ents"] if e.alive),
            "tuning": {k: getattr(sim, k) for k in
                       ("K_ABSORB", "REACH", "UNIT", "UPKEEP_FLAT", "UPKEEP_RATE",
                        "STRAIN_K", "HUNGER_GRACE", "HUNGER_EXP", "HUNGER_DRAIN",
                        "LOOT_PCT", "SKILL_GAIN", "SKILL_DECAY", "REGROW",
                        "READ_FRAC")},
            "grammar": grammar()}

# ---------------------------------------------------------------- behaviour library
# Authored flowcharts are stored on disk as one JSON file per named behaviour, in a
# `behaviours/` folder next to this file -- plain files, so they can be edited, diffed and
# versioned like any other asset. The sim reads the same folder (`sim.saved_behaviours`)
# to decide what entities are born running, so saving a chart here and resetting the world
# is how a behaviour enters play.
def _behaviours_dir():
    os.makedirs(sim.BEHAVIOUR_DIR, exist_ok=True)
    return sim.BEHAVIOUR_DIR

def _safe_name(name):
    safe = "".join(c for c in name if c.isalnum() or c in "-_.")
    if not safe:
        raise ValueError("behaviour name has no usable characters")
    return safe

def list_behaviours():
    """The library as authored, unparsed -- what the editor lists and what a `behaviour`
    node's name is resolved against (decision 33)."""
    return sim.raw_behaviours(_behaviours_dir())

def _calls(graph):
    """The behaviours a graph names directly, off the authored form (so it works on a chart
    that has not been parsed, and on one that will not parse)."""
    nodes = (graph or {}).get("nodes") if isinstance(graph, dict) else None
    return {n["name"] for n in (nodes or {}).values()
            if isinstance(n, dict) and n.get("type") == "behaviour"
            and isinstance(n.get("name"), str) and n["name"]}

def callers_of(name):
    """Which saved behaviours run `name` -- deleting or breaking it breaks them too."""
    lib = list_behaviours()
    return sorted(k for k, g in lib.items() if k != name and name in _calls(g))

def save_behaviour(name, graph):
    safe = _safe_name(name)
    with open(os.path.join(_behaviours_dir(), safe + ".json"), "w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2)

def delete_behaviour(name):
    p = os.path.join(_behaviours_dir(), _safe_name(name) + ".json")
    if os.path.exists(p):
        os.remove(p)

class Handler(BaseHTTPRequestHandler):
    def _send(self, body, ctype="application/json"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        body = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/validate":
            # The sim's own verdict on an authored chart, with no world to touch: the editor
            # mirrors parse_chart's rules client-side, and this is how it checks its mirror.
            # The library goes with it, since a `behaviour` node is only resolvable against it.
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError as ex:
                return self._err(f"body is not JSON: {ex}")
            try:
                chart = sim.parse_chart(body.get("chart"), list_behaviours())
            except (ValueError, TypeError) as ex:
                return self._err(str(ex))
            return self._send(json.dumps({"ok": True, "nodes": len(chart["nodes"]),
                                          "calls": sorted(_calls(body.get("chart")))}))
        if u.path == "/api/behaviours":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError as ex:
                return self._err(f"body is not JSON: {ex}")
            name = body.get("name")
            graph = body.get("graph")
            if not isinstance(name, str) or not name.strip():
                return self._err("behaviour needs a name")
            if not isinstance(graph, dict):
                return self._err("behaviour needs a graph object")
            try:
                save_behaviour(name, graph)
            except ValueError as ex:
                return self._err(str(ex))
            return self._send(json.dumps({"behaviours": list_behaviours()}))
        if u.path != "/api/rules":
            return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError as ex:
            return self._err(f"body is not JSON: {ex}")
        e = next((x for x in STATE["world"]["ents"] if x.id == body.get("id")), None)
        if e is None:
            return self._err(f"no entity {body.get('id')!r}")
        try:
            chart = sim.parse_chart(body.get("chart"), list_behaviours())
        except (ValueError, TypeError) as ex:
            return self._err(str(ex))
        e.chart = chart                        # takes effect next tick
        _fork()      # the world is not what it was: whatever was recorded after now is void
        STATE["log"].append({"t": STATE["world"]["tick"], "e": e.id, "kind": "authored",
                             "n": len(chart["nodes"])})
        return self._send(json.dumps(snapshot()))

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path != "/api/behaviours":
            return self.send_error(404)
        q = parse_qs(u.query)
        name = q.get("name", [""])[0]
        if not name:
            return self._err("name required")
        orphaned = callers_of(name)
        try:
            delete_behaviour(name)
        except ValueError as ex:
            return self._err(str(ex))
        return self._send(json.dumps({"behaviours": list_behaviours(), "orphaned": orphaned}))

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "web", "index.html"), "rb") as f:
                return self._send(f.read(), "text/html; charset=utf-8")
        if u.path == "/index.css":
            with open(os.path.join(HERE, "web", "index.css"), "rb") as f:
                return self._send(f.read(), "text/css; charset=utf-8")
        if u.path == "/index.js":
            with open(os.path.join(HERE, "web", "index.js"), "rb") as f:
                return self._send(f.read(), "application/javascript; charset=utf-8")
        if u.path == "/flowchart":
            with open(os.path.join(HERE, "web", "flowchart.html"), "rb") as f:
                return self._send(f.read(), "text/html; charset=utf-8")
        if u.path == "/flowchart.js":
            with open(os.path.join(HERE, "web", "flowchart.js"), "rb") as f:
                return self._send(f.read(), "application/javascript; charset=utf-8")
        if u.path == "/syntax.js":
            # the written form of the grammar (decision 32) -- the browser's copy of
            # sim/syntax.py, which the editor parses and checks with as you type
            with open(os.path.join(HERE, "web", "syntax.js"), "rb") as f:
                return self._send(f.read(), "application/javascript; charset=utf-8")
        if u.path == "/flowchart.css":
            with open(os.path.join(HERE, "web", "flowchart.css"), "rb") as f:
                return self._send(f.read(), "text/css; charset=utf-8")
        if u.path == "/api/behaviours":
            return self._send(json.dumps({"behaviours": list_behaviours()}))
        if u.path == "/api/grammar":
            # The vocabulary on its own, without a world snapshot, so the editor is generated
            # from the sim's grammar instead of keeping a hand-copied duplicate of it.
            return self._send(json.dumps(grammar()))
        if u.path == "/api/state":
            return self._send(json.dumps(snapshot()))
        if u.path == "/api/tick":
            advance(int(q.get("n", ["1"])[0]))
            return self._send(json.dumps(snapshot()))
        if u.path == "/api/goto":
            # replay: the world goes back (or forward) to a tick it has already been at,
            # whole -- cells, bodies, stats, skill, hunger, trails and the rng (decision 37)
            goto(int(q.get("t", [STATE["world"]["tick"]])[0]))
            return self._send(json.dumps(snapshot()))
        if u.path == "/api/reset":
            reset(int(q.get("seed", [STATE["seed"]])[0]))
            return self._send(json.dumps(snapshot()))
        self.send_error(404)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8866
    reset(int(sys.argv[2]) if len(sys.argv) > 2 else 7)
    print(f"http://localhost:{port}   seed {STATE['seed']}  (ctrl-c to stop)")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
