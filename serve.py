"""Browser front end for sim.py. Stdlib only -- decision 18.

    python3 serve.py [port] [seed]     then open http://localhost:8000
"""
import json, os, random, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

import sim

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_CAP = 4000

STATE = {"world": None, "seed": 7, "log": []}

def reset(seed):
    STATE["seed"] = seed
    STATE["world"] = sim.make_world(random.Random(seed))
    STATE["log"] = []

def advance(n):
    w = STATE["world"]
    for _ in range(n):
        if not any(e.alive for e in w["ents"]):
            break
        STATE["log"] += sim.run_tick(w, w["tick"] + 1)
    del STATE["log"][:-LOG_CAP]

def snapshot(log_tail=600):
    w = STATE["world"]
    cells = [{"q": p[0], "r": p[1], "stat": c.stat, "delta": round(c.delta, 2),
              "amount": round(c.amount, 1), "cap": round(c.cap, 1), "wild": c.wild}
             for p, c in w["cells"].items() if c.amount > 0.05]
    ents = []
    for e in w["ents"]:
        n = max(1, int(round(e.stat["rules"])))
        ents.append({
            "id": e.id, "q": e.pos[0], "r": e.pos[1], "alive": e.alive, "died": e.died,
            "stat": {k: round(v, 2) for k, v in e.stat.items()},
            "strain": round(e.strain, 2), "condition": round(e.condition, 3),
            "read": sim.read_radius(e),      # decision 23: half sense, where stats become legible
            "skill": sorted(([f"{k[0]} {'+' if k[1] > 0 else '-'}", round(v, 2)]
                             for k, v in e.skill.items()), key=lambda x: -x[1]),
            "rules": [{"cond": sim.fmt_cond(c), "act": sim.fmt_act(a), "active": i < n,
                        "raw": [c, a]}
                      for i, (c, a) in enumerate(e.ruleset)],
            "trail": [[p[0], p[1]] for p in e.trail],
            "acts": dict(e.acts), "archetype": sim.archetype(e),
        })
    return {"tick": w["tick"], "radius": sim.MAP_RADIUS, "seed": STATE["seed"],
            "cells": cells, "ents": ents, "events": STATE["log"][-log_tail:],
            "alive": sum(1 for e in w["ents"] if e.alive),
            "tuning": {k: getattr(sim, k) for k in
                       ("K_ABSORB", "FALLOFF", "UPKEEP_FLAT", "UPKEEP_RATE",
                        "STRAIN_K", "STRAIN_DRAIN", "LOOT_PCT", "SKILL_GAIN",
                        "SKILL_DECAY", "REGROW", "READ_FRAC")},
            "grammar": {"cond": sim.COND_SPEC, "act": sim.ACT_SPEC, "sel": sim.SEL_SPEC,
                        "stats": sim.STATS, "ops": list(sim.OPS)}}

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
            ruleset = sim.parse_ruleset(body.get("rules"))
        except (ValueError, TypeError) as ex:
            return self._err(str(ex))
        e.ruleset = ruleset                    # decision 21: takes effect next tick
        STATE["log"].append({"t": STATE["world"]["tick"], "e": e.id, "kind": "authored",
                             "slots": len(e.active_rules()), "n": len(ruleset)})
        return self._send(json.dumps(snapshot()))

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self._send(f.read(), "text/html; charset=utf-8")
        if u.path == "/api/state":
            return self._send(json.dumps(snapshot()))
        if u.path == "/api/tick":
            advance(int(q.get("n", ["1"])[0]))
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
