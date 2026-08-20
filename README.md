# substrate

A simulation where the player controls character **behaviour via a state machine**, not
moment-to-moment input. The world is a hex-grid arena populated by entities whose rules and
stats evolve under natural selection — with death, rebirth and karma sorting similar-behaving
characters together.

The centre being built first is the **simulation substrate**: the arena where characters affect
each other. Karma, rebirth and genes are wanted but none are implementable until the arena is
interesting on its own.

See [DESIGN.md](DESIGN.md) for the running record of decisions.

## Run it

No dependencies — Python stdlib only.

```bash
python3 serve.py [port] [seed]     # e.g. python3 serve.py 8000 7
```

Then open http://localhost:8000.

## What you get

- A hex map with a resource economy, per-entity inspection, and single-tick stepping.
- Each entity runs an **ordered list of if→do rules** — a state machine with no stored state,
  where "what state am I in" is read back out of the world each tick.
- You can **edit any entity's rule list in place**, from a grammar-generated editor, and watch
  the change land on the next tick.
- The simulation loop: snapshot → sense → decide → resolve → reap.

## Structure

- `sim.py` — the model: arena, entities, rule grammar, the tick loop. Runnable standalone
  (`python3 sim.py`) for a headless run with a text map and lifespan stats.
- `serve.py` — stdlib HTTP server that serves `index.html` and the `/api/*` JSON endpoints.
- `index.html` — the browser front end: map, inspector, rule editor, event log.
- `DESIGN.md` — the design log, one decision at a time.
