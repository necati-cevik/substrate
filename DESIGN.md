# Design notes

Running record of decisions. Built one decision at a time — nothing here is filler, and
anything not listed is still open.

---

## Premise (given)

- The player controls character **behaviour via a state machine**, not moment-to-moment input.
- The world has a **population governed by evolution / natural selection**.
- After death there is **rebirth according to karma**, which places similar-behaving
  characters together.
- **State machine capability is governed by the genes** that natural selection acts on.
- ~~There are several planes of existence.~~ *(parked — see Parked)*
- Player characters have **NPC progeny**.
- Player characters are **reborn into available NPCs**.

## Where the fun is (decided)

The main player action is **deciding character strategy**. The payoff is seeing the effects of
that decision:

- through generations
- in interactions with other characters
- in planes of existence shifting and changing

## Current focus

**The simulation substrate — the arena where characters affect each other.** Karma, rebirth,
genes and environmental effects are all wanted, but none are implementable until the centre is
interesting on its own.

## Decisions

### 1. Karma sorts rebirth placement

Similar-acting characters are placed near each other on rebirth. One map, continuous placement —
no planes, no separate worlds, and therefore no split rule to design.

Regions acquire character entirely from who gets placed in them. Combined with clustered deltas
(decision 11), placement decides what economy you are born into: predators land among picked-over
ground, gatherers among ground that regrows.

### 2. Actions are the force behind everything

**actions → karma → placement.**

> Heaven is heaven not because it is given, but because it is full of good people doing good
> things. Hell likewise.

Anything that lets a region be good or bad for reasons other than its inhabitants' behaviour is
wrong. Dropping planes strengthens this — a plane was the last thing that could have had authored
properties.

### 3. No authored content lists

No verb list, no resource roster. Same objection to both: a list of named things is content we
invent instead of derive. Verbs may still *emerge* as names for parameter regions that turned out
to matter — applied after the fact, never as primitives.

### 4. An action is an atomic stat change

```
action = (actor, target_cell, stat, delta)
```

- **Targets a cell, not an entity**, so acting on what you can't see is expressible. Whoever
  occupies the cell receives it; an empty cell wastes the action.
- **Position is a stat**, so movement is a delta on your own position and push/pull is the same
  atom aimed elsewhere. No displacement system.

### 5. Reach trades against magnitude

```
delivered = power / (1 + falloff * max(0, distance - 1))
```

No reach check and no range rejection — only attenuation. Melee and ranged are a continuum set by
`falloff`, not two categories. Reach is measured from adjacency, not from zero: decision 20 makes
distance 1 the closest you can stand to anyone, so that is where effect is full.

### 6. Arena: hex grid

Axial integer coordinates, 6 uniform neighbours, exact distances, no diagonal bias.

### 7. The tick loop

```
tick(world):
  1. SNAPSHOT   snap = freeze(world)
  2. SENSE      views[e] = filter(snap, e)              # what e perceives, per e.sense
  3. DECIDE     intents[e] = e.machine.step(views[e])    # pure; one action or idle
  4. RESOLVE    for a in intents: apply delivered delta at a.target_cell
  5. REAP       entities with hp <= 0 die — after every delta has landed
```

### 8. Rules of the arena

- **R1 Simultaneity.** One frozen snapshot; nobody sees this tick's changes. Deterministic and
  order-independent. *Protect hardest* — sequential resolution makes turn order a hidden stat.
- **R2 One slot per tick.** Movement competes with everything else, so closing distance costs a
  strike.
- **R3 Speed is movement distance per move action**, not tick rate. Every entity ticks at the same
  rate.
- **R4 Death is reaped after resolution.** Mutual kills happen; a dying blow still lands.

### 9. Sense is accuracy, not permission

Sense sets what you know, never what you may do. Bad or missing information wastes your slot; it
is never illegal.

### 10. There is a resource economy

Resources are the reason to act: free in the wild, gathered, driving both survival and growth.
Upkeep drains every tick (decision 13), so action is compelled rather than merely incentivised.
On death a percentage of you is left behind; the rest is destroyed.

The wild creates, gathering converts, combat destroys — so gatherers are arithmetically richer
than raiders, and the loot percentage is the knob setting how much the world rewards which.

### 11. Resources are stat deltas, not substances

A resource cell holds `(stat, delta, amount)` — the action atom minus the actor. Gathering is
`(me, resource_cell, stat, +delta)`. Three subsystems stop being needed: **hazards** are cells
with negative deltas, **terrain** is cells with position deltas, **loot** is a corpse becoming a
cell.

Deltas must be spatially clustered or location means nothing. A region's mix of deltas is what
makes it liveable: full spread supports growth, upkeep-only supports subsistence without growth,
upkeep-scarce supports nothing for long.

### 12. Non-linearity is in absorption, not price

```
absorbed = delta / (1 + k * stat)
```

Same shape as decision 5: distance attenuates what you deal, existing level attenuates what you
take. Buys anti-snowball with no price table, and makes **altruism arithmetically efficient** — a
delta nearly wasted on someone rich in that stat lands almost whole on someone poor in it, so
sharing extracts more from the same world than hoarding. Decision 3 derived rather than asserted.

Risk: large `k` pushes everyone toward generalist builds.

The rules stat is discrete by construction, so its curve is lumpy while hp/speed/sense are smooth.

### 13. Upkeep is strain

Every tick, unpaid upkeep accrues as **strain** — proportional to everything you carry, so
holding big stats still costs. Drawing anything from the wild pays it down.

```
strain += flat + rate * sum(stats)      # every tick
hp     -= drain * strain                # strain bleeds you
condition = 1 / (1 + k * strain)        # decisions 5 and 12's shape
```

Strain does two things, and that is the whole of it:

- **It is a negative percentage modifier on everything you do** — the exact mirror of skill
  (decision 15). Delivered effect, movement distance and rule slots are all multiplied by
  `condition`. Neglect makes you worse at acting.
- **It bleeds hp**, so unpaid upkeep still ends in death. R4 is untouched: death is hp at zero.

Read the penalty off strain, never off hp: **a wounded character is not a clumsy one.** Injury
and neglect are different things and only one of them makes you incompetent.

Stats themselves do not decay. The tax on the powerful survives in the proportional term — a big
character accrues strain faster — and a deliberately small character stays cheap to run.

Any draw from the wild relieves strain, so no food stat and no food/poison split is needed;
decision 11 stands as written.

**The spiral is emergent, not authored.** Strain weakens what you do, and gathering depends on
what you can do, so falling behind compounds without an acceleration term. Slots go with it:
`round(rules * condition)`, so desperation strips you to your top priorities.

*Superseded:* an earlier version decayed every stat directly. It made small-magnitude stats hit
zero far sooner than hp (rules in ~55 ticks, speed in ~35) and froze characters into
immobile one-rule stumps long before they starved.

### 14. The machine is an ordered list of if→do rules

```
machine = [ (condition, action), ... ]        # 3–4 slots to start
step(view) = first rule whose condition holds; none holds = idle
```

No states, no transitions. **The `rules` stat is the number of slots** — named for what it does,
so decision 12's "discrete by construction" is literally a count.

Nothing is remembered between ticks, which is why this shape and not a graph: `step` stays pure as
decision 7 already assumes, and *what state am I in* is read back out of the world — own hp,
what's nearby — instead of stored. Modes still exist; they are conditions.

Priority is authored by ordering. The player's entire strategy is which three or four things
matter and in what order.

Cost accepted: no history-dependent behaviour — no "go back to where the food was" — until memory
is itself a stat.

### 15. Skill is per-action-type efficiency that grows with use

Skill is a **percentage modifier on the effect of an action**, one per action type, starting at
100% and earned by performing that type.

```
type      = (stat, sign)                          # derived from the atom, not a list
delivered = power * skill[type] / (1 + falloff * max(0, distance - 1))
skill[t] += gain / (1 + k * skill[t])             # on use; decision 12's shape
```

Taken because it is the counterweight to decision 12's logged risk: absorption pushes everyone
toward generalist builds, repetition-reward pushes back toward specialists.

**Type is derived, not authored.** `(stat, sign)` is the action atom minus actor, target and
magnitude — acting on hp downward is a different practice from acting on hp upward. The skill
table is therefore the emergent verb roster decision 3 allows: names applied after the fact to
whichever cells of it people actually fill.

Skill multiplies on the delivering side only. Reach still attenuates it (decision 5) and the
target's existing level still absorbs it (decision 12), so a skilled specialist is efficient, not
exempt.

Skill is a stat, so decision 13 decays it. Use-it-or-lose-it: equilibrium skill is how often you
do the thing, and the proportional decay term means a few high skills cost what many low ones do.
No cap authored, none needed.

Skill is learned within a life; genes set rule slots across lives. Two channels, deliberately.

### 16. Condition and action vocabulary

Forced by building. A rule tests only facts the model already contains, and names a target only by
description — never by coordinate, since coordinates aren't perceivable.

```
condition = SELF(stat) </> v | OTHER(stat) </> v | DIST(selector) </> v
          | AMOUNT(selector) </> v | COUNT(entities) </> v | ALWAYS
action    = MOVE(selector, toward/away) | ACT(selector, stat, +/-)
selector  = nearest entity | nearest source of (stat, sign) | it   (decision 22)
```

Both additions were forced by watching it fail, not reasoned out in advance:

- **A selector names `(stat, sign)`, not just a stat.** Without the sign, a healing cell and a
  damaging one are the same target: an entity walked to a hazard and ate from it nine times
  running. It is the same pair that types actions and keys skill.
- **`AMOUNT` tests what a source has left.** Without it a gatherer parks on one patch, drains it,
  and farms the regrowth for less than its upkeep — gathering every single tick and still dying,
  with no way to express "this patch is spent". Adding the test took the same strategy from 119
  to 145 ticks.

Selectors resolve against the sensed view only. An unresolvable selector wastes the slot rather
than skipping to the next rule — decision 9, bad information costs you, it is never illegal.

`MOVE` is `ACT` on your own position with the direction taken from the selector; it is listed
separately for authoring, not as a second primitive.

### 17. Creation is funded, destruction is free

Forced by building: decision 5 hands you `power` of delta per action, and nothing said where a
positive delta comes from — as written you could top yourself up from nothing and never need the
world.

- **Negative delta on an entity** costs only your slot. It destroys; you gain nothing.
- **Positive delta on an entity** is drawn from your own stat of the same kind. Giving costs.
- **Positive delta from a resource cell** is drawn from that cell's `amount`. The wild pays.

This is decision 10's "the wild creates, gathering converts, combat destroys" stated as a rule
instead of a slogan, and it is what makes decision 12's altruism claim mean anything: giving is
only efficient if it costs the giver.

**Stats floor at zero; only hp crosses it, and crossing it is death.** Found by running: harm had
no floor, so a drained stat went negative, which made delivered effect negative, which
turned giving into draining and inverted this decision exactly.

### 18. Stack: Python, stdlib only

`sim.py` is the model, `serve.py` and `index.html` are a browser front end for watching it.
No dependencies, chosen to stay cheap to throw away while the rules are still moving.

### 19. Magnitude is a constant, not a stat

`capacity` is gone; `deliver` uses a flat `POWER`. Measured: 88% of entities died with it still at
its start value, so it was a constant wearing a stat's costs.

`capability` is renamed `rules` — it only ever set the slot count.

### 20. One entity per hex

Two entities cannot hold the same space. Targeting a cell now names exactly one recipient, and an
occupied hex is a wall.

- **A move takes you as close as it can get.** Walk the path; if the far end is taken, fall back
  one hex along it and try again. Crowding packs in around a contested cell instead of freezing
  everyone in place.
- **A contested cell goes to the fastest claimant**, on `speed * condition` read off the frozen
  snapshot. Arbitration was never the thing to avoid — turn order was; this is a stat, so R1
  holds. A stayer always keeps its own cell, and an exact tie yields for everyone. Each round only
  shortens a path, so the fixed point terminates.
- **Only the destination is checked; paths pass through.** Everyone moves inside the same frozen
  snapshot, so mid-path blocking has no order-free answer.
- **Reach is measured from adjacency** (decision 5, amended): distance 1 is the closest anyone can
  stand, so that is where effect is full.

Found by measuring: `step_towards` had no option to stand still, so an entity sitting on its own
target stepped off and tried to come back forever. Standing still is now a candidate, and arriving
logs as `hold`, distinct from `blocked`.

Of 12,920 move intents over 20 seeds: 2,519 move, 5,703 hold, 4,698 blocked. **95% of the blocked
are at distance 1** — adjacent to a source, trying to stand on it, refused by whoever is parked
there. Since decision 5 now pays full effect at distance 1, that step buys them nothing. Open:
whether `move toward` should treat adjacency as arrival, which would make source cells public —
six entities could ring one and all draw at full power, and contention for them would vanish.

### 21. The player edits the rule list in place, from the grammar

The rule list in the inspector is the editor: each slot's condition and action are dropdowns over
decision 16's vocabulary, so no reachable state of the UI is an illegal rule.

- **The grammar is served as data** (`COND_SPEC`, `ACT_SPEC`, `SEL_SPEC`), and the editor is
  generated from it. Adding a condition kind to the sim adds it to the UI; nothing restates the
  grammar twice.
- **Edits land on the next tick**, mid-life, on the live entity. Answers half of open question 10:
  you can rewrite the list while the life is running.
- **Order is priority**, so reordering is an edit — raise, lower, duplicate, delete, add.
- **The server validates and rejects**; a refused edit stays in the editor with the reason. Decision
  9 is about bad information *inside* the sim, not about letting malformed rules into it.

Taken because the rule list was the one part of the model you could read but not touch, and
authoring is what makes decisions 14 and 16 testable by hand rather than by seed.

### 22. An action can target what the condition matched

The selector `it` names whatever the rule's condition was about, so the test and the act cannot
describe two different things.

- **The condition returns a subject, not just a verdict.** `DIST`/`AMOUNT` bind the entity or
  source cell they measured; `SELF`, `COUNT` and `ALWAYS` bind nothing, and `it` against them
  wastes the slot — decision 9 again.
- **A resolved target carries its kind**, entity or source, so `act on it` gathers from a bound
  cell and hits a bound entity without the selector restating which it is.
- Quantifiers stay as they were: an entity condition still tests the *nearest* entity, so `it` is
  today the same target read once instead of twice. It stops being redundant the moment a
  condition can test another entity's stats. *(Decision 23: it now can, and `it` is the only way
  to act on what the reading found.)*

Taken because the alternative is writing the description twice and hoping both resolve the same
way.

### 23. Other entities are readable at half your sense range

`OTHER(stat) </> v` tests the stats of the nearest entity close enough to read. Sense stays one
stat with two ranges: **presence carries to `sense`, detail only to `sense/2`.**

```
read_radius = max(1, int(sense * READ_FRAC))     # READ_FRAC = 0.5
condition   = OTHER(stat) </> v                  # nearest entity within read_radius
```

Taken because a rule list that cannot see who it is dealing with can only describe the world and
itself, never the other party — every social strategy (pick on the weak, flee the strong, give to
the poor) was inexpressible.

- **Nearest *readable*, not nearest.** One you cannot read is not a subject the condition can be
  about, so the quantifier resolves inside the read radius. Nobody in it makes the condition false
  — decision 9 again, bad information costs you the slot.
- **It binds its subject**, so `act on it` hits exactly who was measured (decision 22).
- **Reading is not permission.** `nearest entity` still targets anyone you can sense, unread.
  Sense sets what you know, never what you may do.

Measured, all 30 entities on the same list, median lifespan over 7 seeds, 3000-tick cap:

| strategy | median | note |
|---|---|---|
| avoider — flee anyone above 15 hp, else graze | 180 | best list yet |
| grazer — baseline, no reading | 113 | |
| almsgiver — heal anyone below 8 hp, else graze | 105 | |
| opportunist — strike anyone below 10 hp, else graze | 100 | |
| raider — strike whatever is near, unread | 8 | mutual annihilation |

Reading pays for **avoidance**, not for aggression: knowing a rival is weak buys almost nothing
(100 vs 113), knowing one is strong buys 60%. And the half is close to optimal, not a round
number — same list, varying the fraction: radius 1 → 137, radius 3 → 180, radius 6 → 166. Full
sense makes you flee constantly and never eat; radius 1 sees the threat too late.

Open: whether a *selector* for the nearest readable entity is needed, or whether `it` is enough.

### 24. The interface has one code: hue is the stat, a sign glyph is the direction

Map marks and rule lines are both drawn from `(stat, sign)` -- the pair that already types
actions and keys skill -- so the UI never invents a vocabulary the model does not have.

```
hp ♥ green    speed » amber    sense ◉ violet    rules ≡ pink
+ gain (blue sign)                 − loss (red sign)
```

- **Ground says what it does.** `+♥` / `−♥` in the hex, fill height is what is left, hatching
  means it takes. The old flat tint could not say which stat a hazard ate.
- **Bodies say what they have been doing.** Shape *and* hue carry the emergent archetype
  (decision 3) -- circle gatherer, triangle raider, diamond giver, square wanderer, hollow
  inert; size is hp, the red ring is strain.
- **The tick is drawn.** A line from actor to target cell coloured by what it delivered, and
  `?` / `⊘` / `·` on anyone whose slot delivered nothing -- decision 9's wasted slots are
  now visible on the map, not only in the log.
- **Rule text is rendered from the raw rule, not from the server's string**, so the reading
  and the map cannot drift apart. Syntax (`if`, `→`, the kind dropdowns) is grey: colour is
  spent on meaning only.

## Substrate status

`sim.py` runs the arena; `serve.py` serves it to a browser at `localhost:8000` — hex map,
per-entity inspector (stats, strain, condition, an editable rule list with the fired rule marked
and out-of-slot rules dimmed, skill table), a full event log filterable to one entity, and
single-tick stepping. Stdlib only.

Median lifespan over 7 seeds, 3000-tick cap:

| strategy | median | note |
|---|---|---|
| grazer — eats, moves on when the patch is spent | 145 | |
| raider — attacks whatever is near, eats opportunistically | 129 | |
| gatherer — eats but never leaves the patch | 119 | |
| random 3-4 rules | 76 | |
| idler — never acts | 76 | |

What that says so far:

- **Strategy roughly doubles your life**, and the ordering matches decision 10's arithmetic —
  gatherers beat raiders — without anything in the code favouring it.
- **Scarcity is not the binding constraint; R2 is.** Richer wild, faster regrowth and evenly
  spread deltas changed nothing measurable. With one action per tick, food you cannot reach with
  that action is the same as no food.
- **Nobody reaches equilibrium.** Every life still ends. Whether that is a design choice or an
  unavoidable arithmetic is unmeasured, and it is the question the numbers have to answer.
- Random rule lists spend most of their slots on `wasted` and `idle` — targets they cannot
  perceive. Decision 9 is doing real work, and it is visible in the log.
- Entities strip each other's `rules` unprompted: `act -rules on nearest entity` is a
  cheap way to make a rival stupid, and decision 17 makes destruction free. An unplanned verb
  that decision 3 would let us name after the fact.

## Parked

- **Planes of existence**, and the Buddhist cosmology frame that went with them (animal as hunger
  and instinct, human as choice, deva as unpressed, preta as craving, naraka as endurance). Still
  wanted as a reading of the world; not driving mechanics. What survives mechanically is decision
  1 — karma sorting placement.

## Deferred deliberately

- Engine / language / stack — settled cheaply as decision 18; still not important.
- **Initial stat distribution, how stats propagate, and how generations work.** Explicitly parked
  until the arena is worth inheriting into. The sim starts everyone identical and no one breeds.
- ~~**How the player authors** the rule list~~ — settled as decision 21: an in-place list editor
  generated from the grammar. The internal representation was already settled: decision 14.
- Stat roster and distribution. Now `hp, speed, sense, rules`: what you can absorb / when / read /
  decide. Magnitude is the flat `power` constant, not a stat -- see decision 19. Skill
  (decision 15) sits alongside as a sparse family — one entry per `(stat, sign)` actually used.
  Numbers are expected to be more fun to pick once actions work.

## Open

Roughly in the order they'll need answering:

1. **Numbers** — `k` for absorption, `falloff`, upkeep rate, loot percentage, spawn and regrowth,
   and skill's `gain` against its decay. Now the live question, because the sim makes them
   measurable instead of guessable.
2. **Is there an equilibrium?** Whether a good strategy can hold station indefinitely or only
   decline slowly. Decides whether death is a design choice or an unavoidable arithmetic.
3. **How resources cluster** — what generates the spatial distribution of deltas. Currently random
   blobs, which is a placeholder, not a decision.
4. **Initial stats, propagation, generations** — parked by choice; the first thing to pick up once
   the arena is interesting.
5. What karma is, concretely — the axes, and how actions accumulate into them. Cheaper than it
   was: every action carries a sign and a target, so the ledger already exists — and decision 15
   keys skill off that same `(stat, sign)` pair, so karma and skill may be two readings of one
   tally.
6. **Does skill survive rebirth?** If it does, skill is the mechanical shape of a tendency and
   overlaps whatever karma turns out to be. If it doesn't, every life relearns. Bound up with 5
   and 8.
7. Genes -> rule slots — how many slots genes buy, and what selection pressure keeps brains honest.
8. Progeny and rebirth — do offspring inherit the authored rule list? Does karma fully determine
   the body you wake in, or choose a pool you then pick from?
9. Other recurring characters — are there other reincarnating souls you meet across lives?
10. Pacing — how long is a life, and can you rewrite the rule list mid-life?
11. Actions affecting the environment itself — wanted, parked until the centre is fun.
12. ~~**How the player authors rules**~~ — settled as decision 21: dropdowns over the grammar,
    edited in place in the inspector. What is still open is authoring *before* a life starts, and
    whether the player edits one entity or a whole lineage.

## Process

Decisions get made one at a time and recorded here. No speculative design ahead of the
decisions.
