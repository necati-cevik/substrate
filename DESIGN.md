# Design notes

Running record of decisions. Built one decision at a time — nothing here is filler, and
anything not listed is still open. A decision earns an entry only if it was actually
contested; obvious engineering norms are implementation, not design.

---

## Premise (given)

- The player controls character **behaviour**, not moment-to-moment input. Behaviour is
  described as a flow chart (decision 26).

Nothing else is given. The former premise bullets — evolution / natural selection, karma
sorting rebirth, genes governing capability, NPC progeny, rebirth into available NPCs — are
no longer part of the foundation. Rebirth is *wanted* but has no mechanism yet (see Open).

## Where the fun is (decided)

The main player action is **deciding character strategy**. The payoff is seeing the effects
of that decision play out between characters. The world those decisions act on is a work in
progress — that is the focus, not a decided thing.

## Current focus

Two things, 1a and 1b:

- **1a. How the map is made.** Where resources and hazards are placed, what players can do
  to cells, how movement works.
- **1b. How players create strategies.** The flow-chart behaviour description and how the
  player authors it. The vocabulary is worked backwards from player behaviour descriptions,
  not designed forward.

The immediate goal is a working demo that shows how entities interact.

## Decisions

Surviving decisions keep their original numbers. Dropped and replaced ones are listed in
their own section at the end.

### 4. An action is an atomic stat change — as the substrate

```
action = (actor, target_cell, stat, delta)
```

- Targets a cell, not an entity. Whoever occupies the cell receives it; an empty cell wastes
  the action.
- Position is a stat, so movement is a delta on your own position. No displacement system.
- **The player never writes atoms.** The player-facing description is the flow chart
  (decision 26); it compiles down into atoms. The atom is the layer effects land in, not the
  layer strategy is written in.

### 5. Reach is adjacency

An action lands on your own cell or one of its six neighbours. There is no ranged effect and
no attenuation curve: effect is full at distance 0–1 and does not exist further out.

*Supersedes* the falloff formula (`delivered = power / (1 + falloff * max(0, distance-1))`)
and the melee/ranged continuum that came with it.

### 6. Arena: hex grid

Axial integer coordinates, 6 uniform neighbours, exact distances, no diagonal bias.

### 7. The tick loop

```
tick(world):
  1. SNAPSHOT   snap = freeze(world)
  2. SENSE      views[e] = filter(snap, e)              # what e perceives, per e.sense
  3. DECIDE     intents[e] = e.machine.step(views[e])   # one action or idle
  4. RESOLVE    for a in intents: apply the delta at a.target_cell
  5. REAP       entities with hp <= 0 die — after every delta has landed
```

### 8. Rules of the arena

- **R1 Simultaneity.** One frozen snapshot; nobody sees this tick's changes. Deterministic
  and order-independent.
- **R2 One slot per tick.** All actions happen simultaneously, one action at a time.
- **R3 Speed is the number of actions per tick**, not movement distance. Every entity ticks
  at the same rate, but a faster one takes more actions in a tick. Each action is one move
  of a single hex or one act. Move-and-act in the same turn is the payoff: a slow unit spends
  its whole budget on a single move, a fast one moves and strikes (decision 30).
- **R4 Death is reaped after resolution.** Mutual kills happen; a dying blow still lands.

### 10. There is a resource economy

Resources are the reason to act: free in the wild, gathered, driving both survival and
growth. Upkeep drains every tick (decision 13), so action is compelled rather than merely
incentivised. On death a percentage of you is left behind; the rest is destroyed.

The wild creates, gathering converts, combat destroys.

### 11. Resources are stat deltas, not substances

A resource cell holds `(stat, delta, amount)` — the action atom minus the actor. Gathering is
`(me, resource_cell, stat, +delta)`. Hazards are cells with negative deltas, terrain is
cells with position deltas, loot is a corpse becoming a cell.

Deltas must be spatially clustered or location means nothing. A region's mix of deltas is
what makes it liveable.

### 12. Every stat change passes through modifiers

There is no raw delta arithmetic: each *kind* of stat change is scaled by its own modifiers.
The known cases:

- **Absorption** attenuates what you take: `absorbed = delta / (1 + k * stat)` — diminishing
  returns as the anti-snowball.
- **Skill** amplifies what you deliver (decision 15) — a positive, per-action-type modifier.
- **Strain** attenuates what you deliver (decision 13) — the negative mirror of skill.

### 13. Strain is an effect, like skill

Upkeep stays compulsory (decision 10), but its carrier is a modifier, not a bundle:

- **Strain is a negative modifier on what you do** — the mirror of skill, which is a
  positive one. Drawing from the wild pays it down.
- **hp drain is a separate effect**, not part of strain. Neglect still ends in death, but
  the bleed and the clumsiness are two effects, not one mechanism with two outputs.

*Supersedes* the version where strain was a single quantity that both scaled performance and
bled hp directly.

### 15. Skill is per-action-type efficiency that grows with use

Skill is a positive percentage modifier on the effect of an action, one per action type,
earned by performing that type.

```
type      = (stat, sign)            # acting hp downward and hp upward are different practices
skill[t] += gain / (1 + k * skill[t])          # on use; diminishing returns
```

Skill is learned within a life.

### 20. One entity per hex

Two entities cannot hold the same space. Targeting a cell names exactly one recipient, and
an occupied hex is a wall.

- **A move takes you as close as it can get.** Walk the path; if the far end is taken, fall
  back one hex along it and try again.
- **A contested cell goes to the fastest claimant**, on speed as modified (strain included),
  read off the frozen snapshot. A stayer always keeps its own cell, and an exact tie yields
  for everyone.
- **Only the destination is checked; paths pass through.** Everyone moves inside the same
  frozen snapshot, so mid-path blocking has no order-free answer.

### 23. Other entities are readable at half your sense range

The nearest entity within `read_radius = max(1, int(sense * 0.5))` can have its stats
tested. Presence carries to `sense`; detail only to `sense/2`. Reading is not permission —
reach (decision 5), not sense, bounds what you can affect. The reading only sets what your
behaviour can branch on.

Measured (30 entities on the same strategy, median lifespan over 7 seeds): knowing a rival
is weak bought almost nothing (100 vs 113 baseline), knowing one is strong bought 60% (180),
so reading pays for **avoidance**, not aggression. The half is close to optimal: radius 1 →
137, 3 → 180, 6 → 166.

### 26. Behaviour is a flow chart

```
condition --yes/no--> action | another condition | another flow chart
```

A behaviour is conditions branching to an action, a further condition, or a nested chart —
charts compose. The vocabulary of conditions and actions is derived *backwards* from the
behaviour descriptions players actually want to write, added as needed, never as an upfront
roster.

Replaces the ordered if→do rule list (14) and its authored grammar (16).

### 27. Stats: hp, speed, sense + skill entries

- Fixed stats: **hp** (crossing zero is death), **speed** (movement distance per move),
  **sense** (perception range; reading others at half, decision 23).
- **Skill** sits alongside as a sparse family — one entry per `(stat, sign)` actually used
  (decision 15).
- **No capability stat.** Nothing bounds the behaviour chart's size or complexity, and no
  stat exists that could be traded, crafted, or stripped.
- **Magnitude is flat: every action delivers 1 unit**, for now. Reopen only if that turns
  out too coarse.

Replaces decisions 19 and 25.

### 28. Numeric thresholds may be expressions over the entity's own stats

A condition's threshold is no longer only a literal: it may be an arithmetic expression over
the deciding entity's stats, written `u.<stat>` — e.g. `u.sense/2` in place of `3`. So a rule
can read "flee anything within half my sense", not "flee anything within 3 hexes", and the
threshold follows the entity as its stats grow or shrink.

- **The language is tiny on purpose.** Literals, `u.hp` / `u.speed` / `u.sense`, `+ - * /`,
  parentheses and unary minus. Nothing else: no other names, no calls, no attributes, no `**`.
  The parser is a whitelist over Python's own `ast`, compiled once per distinct expression and
  cached, so a threshold that fails to parse is rejected at authoring time, and one that
  evaluates to an error (division by zero) is NaN — and NaN makes every comparison false, so
  the condition simply does not fire (decision 9's spirit: bad information costs a slot, never
  crashes the tick).
- **`u` is the entity deciding**, the same entity the chart is stepped against. No other name
  is bound — a threshold that named a second subject would have to resolve it, which is not a
  number's job.
- **A literal is still a number in the JSON, an expression is a string.** Backwards
  compatible: every existing and randomly-generated rule stays a plain number, and the editors
  keep whichever form was typed.

### 30. Speed is an action budget

Speed is the number of actions an entity may take in a tick, not how far one move carries
it. A move is a single-hex step; an act is one action. So the question the stat answers is
*how many things can I do this turn*, not *how far do I go when I decide to move*.

- **A move is one hex.** `step_towards` already is; the change is that `speed` no longer
  multiplies it. An entity that wants to travel three hexes spends three of its actions.
- **The flow chart's budget is `int(round(speed * condition))`, floored at 1.** Strain can
  strip actions (a desperate unit does fewer things), but never freezes one entirely — the
  same floor the old movement had.
- **Why.** Under the old reading a single move consumed the whole turn, so a unit that had to
  close distance before striking could be kited forever: it moved toward its target while the
  target moved its full (higher) speed away, and the pursuer got no action out of the turn.
  As an action budget, "move next to it and hit it" is two actions — a unit with speed at
  least 2 does both, and every extra point of speed is another thing done, not a longer stride.

*Supersedes* the movement-distance reading of R3.

### 29. Authored charts are saved as JSON files in a folder

The flow-chart editor's library no longer lives in the browser's localStorage. A named chart is
written to `behaviours/<name>.json`, one plain file per chart, and the editor lists, loads and
inlines them through `serve.py` (`/api/behaviours`). The editor page is served at `/flowchart`
alongside the sim.

- **Files because they are the thing you already know how to keep.** Diffable, greppable,
  version-controllable, copyable between machines — the same reasons the grammar and these
  notes are text. No database, no export step: the folder *is* the library.
- **The name is a filename, so it is sanitised** to `[A-Za-z0-9._-]` on the server; anything
  else is dropped. Two names that differ only in a dropped character collide, which is
  accepted for now.
- **The chart stays purely semantic.** Positions are editor state and are not serialised; a
  file holds only the nodes and their edges, the same shape the sim would consume.
- Standalone use (`file://`) still falls back to localStorage, so the editor remains usable
  without the server.

## Substrate status

The `sim/` package runs the arena (`python -m sim`); `serve.py` and the `web/` assets
(`index.html` / `index.css` / `index.js`, plus the flowchart editor) serve it to a browser at
`localhost:8000` — hex map, per-entity inspector, event log. Stdlib only for now; the stack
improves as needs get larger (which stack is used is not a design decision).

The sim runs flow charts (decision 26) with the action budget of decision 30. Still
pre-revision where the doc and code diverge: attenuating reach (old 5), a `power` base
magnitude, a vestigial `rules` slot-count stat (decision 27 drops it, not yet removed), and
funded creation (old 17). The flat rule list and its dropdown grammar (old 14/16/21) are
gone, replaced by the chart machine.

## Dropped

- **1 Karma sorts rebirth placement** — rebirth is wanted, the mechanism is unknown. Moved
  to Open.
- **2 Actions are the only force colouring a region** — authored map properties are allowed;
  focus 1a is exactly about designing them.
- **3 No authored content lists** — authored content is allowed.
- **9 Sense is accuracy, not permission** — not a decision, just obvious; the substance is
  decision 23's last line.
- **14 Rule-list machine, 16 condition/action grammar** — replaced by 26.
- **17 Creation is funded, destruction is free** — dropped.
- **18 Python, stdlib only** — not a decision; the stack improves as needs get larger.
- **19 Magnitude constant / `rules` stat, 25 `rules` carried never traded** — replaced by
  27; there is no capability stat.
- **21 In-place grammar editor** — dropped with the grammar.
- **24 Interface hue/sign code** — not a decision; a readable UI is an engineering norm.

## Open

Roughly in the order they'll need answering:

1. **Map design** — how resources and hazards are placed, what players can do to cells, how
   movement works. (Focus 1a.)
2. **Spawn & generations** — initial stats, whether and how new entities arise, what, if
   anything, is inherited.
3. **Dead characters** — what happens on death. Rebirth is wanted; the mechanism is unknown.
   Waiting on the working demo of entity interaction before this can be seen clearly.

## Process

Decisions get made one at a time and recorded here. No speculative design ahead of the
decisions.
