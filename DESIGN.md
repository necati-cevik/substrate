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
no attenuation curve: effect is full at distance 0–1 and does not exist further out. An act
aimed further away is wasted, not weakened — enforced in the sim as of decision 31, which is
what made the difference legible: with magnitude flat at one, a falloff divider was the only
thing standing in for range, and it let anything inside sense range be hit.

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
  4. RESOLVE    for a in intents, fastest first: apply the delta at a.target_cell
  5. REAP       entities with hp <= 0 die — after every delta has landed
```

### 8. Rules of the arena

- **R1 Simultaneous decision.** One frozen snapshot; nobody sees this tick's changes while
  choosing. Deciding is order-independent; resolving is not — it runs fastest-first
  (decision 31).
- **R2 One action per tick, magnitude one.** Every entity does exactly one thing per tick —
  one hex of movement or one unit of stat change — and nobody does more of it than anybody
  else (decision 31).
- **R3 Speed is initiative.** It does not buy actions or distance; it decides whose action
  resolves first (decision 31).
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

**The wild deals in whole units, and hp is the only one that comes in a heap.** An hp patch
holds 0–10 units and is drawn *one per act* — so a patch is worked over many turns, is worth
standing on, and skill (decision 15) is what decides how fast it comes out. Every other stat
is a **boon, not a larder**: a `speed+` or `sense+` cell holds exactly 1, taken whole in a
single act, and then it is spent. You cannot farm speed; you find it.

A cell yields nothing until it holds a whole unit again. Regrowth is a trickle, so an unripe
cell is bare ground: not drawable, and not even *visible* to a chart looking for a source
(`sense.view_of`). Without that floor, standing on a spent cell and nibbling back the tick's
regrowth would count as a meal, and no one would ever have to move.

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

**Upkeep is owed every turn but collected on a clock: hunger.** Hunger counts turns since
the last draw from the wild, and it is *any* draw that resets it — which is the second thing
a boon cell is for. A `speed+` cell carries no food, yet taking it postpones strain exactly
as a meal does, so a boon is worth a detour twice over.

```
hunger     += 1                        # every turn, for everyone
bite        = 0                        for the first HUNGER_GRACE turns of hunger
            = HUNGER_EXP ** (n - 1)    thereafter, n = hunger - HUNGER_GRACE
strain     += (flat + rate * carried) * bite      # the tax on the powerful, when due
hp         -= HUNGER_DRAIN * bite                 # flat: starving does not care how strong
```

The grace is what makes the economy playable rather than frantic: eat every few turns and
you pay nothing at all. Past it the curve is *small, then suddenly not* — from full hp, an
entity that never draws from the wild loses nothing for 3 turns, 0.15 hp on the 4th, and is
dead around turn 16. Neglect is cheap right up until it is fatal.

*Supersedes* the version where strain accrued flatly every tick and hp bled in proportion to
strain. Both effects now hang off the same clock, and both are off while you are fed.

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
- **A contested cell goes to the fastest claimant** — which decision 31 now gets for free:
  the faster entity resolves in an earlier tier and simply takes the hex, and the slower one
  finds it occupied. A stayer always keeps its own cell, and an exact tie (same tier, same
  destination) yields for everyone.
- **A move is one hex, so there is no path to block.** The destination is the whole move.
- **Only a mover that actually goes vacates its hex.** One that yields is still standing
  where it was, which makes its hex a wall for whoever was stepping into it — and that can
  block them in turn. So a tier's blocking settles by iteration rather than in one pass;
  assuming every mover leaves let two entities end up on one hex, which is the one thing
  this decision forbids.

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
- **Magnitude is flat: every action delivers 1 unit**, before the modifiers of decision 12.
  Implemented as of decision 31.

Replaces decisions 19 and 25.

### 28. Numeric thresholds may be expressions over the entity's own stats

A condition's threshold is no longer only a literal: it may be an arithmetic expression over
the deciding entity's stats, written `my.<stat>` — e.g. `my.sense/2` in place of `3`. So a rule
can read "flee anything within half my sense", not "flee anything within 3 hexes", and the
threshold follows the entity as its stats grow or shrink.

- **The language is tiny on purpose.** Literals, `my.hp` / `my.speed` / `my.sense`, their
  `my.max_<stat>` counterparts, `+ - * /`, parentheses and unary minus. Nothing else: no other
  names, no calls, no further attributes, no `**`. The parser is a whitelist over Python's own
  `ast`, compiled once per distinct expression and cached, so a threshold that fails to parse
  is rejected at authoring time, and one that evaluates to an error (division by zero) is NaN
  — and NaN makes every comparison false, so the condition simply does not fire (decision 9's
  spirit: bad information costs a slot, never crashes the tick).
- **`my` is the entity deciding**, the same entity the chart is stepped against — including
  inside a condition about somebody else, so `their hp < my.hp/2` compares them to you. No
  other subject is bound: a threshold that named a second one would have to resolve it, which
  is not a number's job. `u.<stat>` is the older spelling of the same thing and still parses.
- **The subject is spelled the same on both sides of the comparator.** `my hp` and `my.hp` are
  one condition, so a line reads in one dialect rather than a bare word on the left and a
  dotted name on the right. `my hp > my.max_hp/2` is the shape this is for.
- **`my.max_<stat>` is the entity's ceiling** — its opening roll (decision 35), kept on the
  entity as `Entity.max` and genuinely enforced (decision 36). Only the capped stats have one,
  so `my.max_hp` parses and `my.max_speed` does not: a name for a limit that does not exist
  would be a lie the checker could catch and didn't. What it buys a chart is a per-entity
  denominator — "half my health" is half of *my* twenty-three, not of a constant twenty, and
  it reads the same for an entity born frail or born hardy.
- **A literal is still a number in the JSON, an expression is a string.** Backwards
  compatible: every existing and randomly-generated rule stays a plain number, and the editors
  keep whichever form was typed.

### 31. One action per tick; speed is initiative

Every entity does exactly one thing per tick, and every thing is worth one:

- **One action.** A tick's chart walk stops at the first action it reaches. That branch is
  the whole turn.
- **A move is one hex. An act is one unit** of stat change, before the modifiers of
  decision 12 — skill amplifies it, strain attenuates it, absorption resists it, and reach
  (decision 5) either allows it or wastes it.
- **Speed decides who resolves first, not who does more.** Everyone still senses and decides
  against the same frozen snapshot (R1), blind to what anyone else chose this tick. Effects
  then land in order of effective speed — `speed × condition`, strain included. Equal pace is
  one tier and resolves simultaneously; each tier sees what the tiers above it did.

**Why.** Speed-as-budget made speed the only stat worth having: an extra point was an extra
whole action, and two entities at speed 2 and 4 were not rivals so much as different games.
Flattening it to one action makes every tick a *choice between* actions rather than a
shopping list, which is the thing the flow chart is for — a chart that can do everything each
tick never has to prefer anything.

**Why speed keeps the tiebreak.** The old tick already had a hidden one. Acts resolved before
moves, so an entity fleeing a blow always ate it: the attacker aimed at the cell the target
was standing in, the hit landed against pre-move occupancy, and the escape ran afterwards.
That is a rule about who acts first, just an accidental one that always favoured the
attacker. Speed is the stat that should be answering it. Now:

| fleer vs attacker | outcome |
| --- | --- |
| fleer faster | vacates the hex first; the blow lands on empty ground and is wasted |
| attacker faster | blow lands, then the fleer limps away |
| equal | same tier: blow lands, then the fleer moves — the old behaviour |

An act names a *cell* (decision 4), so this needs no dodge mechanic: leaving before the blow
resolves is the dodge. And because a move is a single hex, the previous iterative
claim-resolution loop is gone — contested cells fall out of the tier order (decision 20).

**What this costs.** Resolution is no longer order-independent, only *decision* is. And a
fast entity behind a slow one is blocked rather than following it: at the instant the fast
one moves, the slow one is still standing there. That is the honest reading of "first".

**What it forbids.** Chaining two actions in one chart branch is now dead code — the walk
restarts at the chart's entry each tick and never reaches the second. "Close, then strike" is written
as a decision instead: *in reach? act : step closer*. The authored archetypes were rewritten
to that shape, and the `seq` builder was removed.

*Supersedes* decision 30 and R3.

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
- **The library is also the spawn pool.** `make_world` deals the saved charts out round-robin,
  so every entity is born running a behaviour you can open, read and edit — saving a chart and
  resetting the world is the whole loop for putting a strategy into play, with no second list
  of starting behaviours to keep in sync. A file that will not parse is skipped rather than
  fatal (the folder is edited by hand as well as by the editor), and the built-in `ARCHETYPES`
  survive only as the fallback for an empty folder.

### 32. Conditions and actions are written, not assembled

A decision holds one condition per line and an action holds one line, typed as text:

    my hp < 10                     dist +hp source <= 1
    their speed >= u.speed         amount +hp source > 0
    count entities > 2             always

    move toward +hp source         act on +hp source
    move away from entity          act -hp on it

Menus are gone from the node bodies. Assembling a condition from four dropdowns cost four
clicks per condition and read as four boxes; the same condition is one line to type and one
line to read, and a chart of a dozen nodes can be skimmed instead of decoded.

- **The written form is a surface, not a second grammar.** Every parse ends by handing its
  tuple through `sim/rules.py`, the same gate the menus went through, so text can express
  exactly what the menus could and nothing more. The inverse holds too: any tuple can be
  written back out as the text that produces it, and the round trip is exact over the whole
  grammar — so charts authored before this (and anything pasted into the json tab as tuples)
  open as text and can be typed over.
- **The checker is the point.** `sim/syntax.py` and its browser mirror `web/syntax.js` fail
  with a position: the offset of the word at fault, its length, and the words that would have
  been legal there. The editor underlines the word, prints a caret under it, says what it
  expected, and offers each legal word as a button — so the menu's one virtue, *you cannot
  name something that does not exist*, survives as a one-click fix rather than a cage.
- **Filler is optional, not decorative.** `nearest`, `the`, `source` and parentheses may be
  written or left out (`dist(+hp source) <= 1` and `dist +hp source <= 1` are the same
  condition), and `gather +hp` reads as `act on +hp source`. There is exactly one canonical
  spelling per tuple — the one the editor writes back — and several ways to type it.
- **What the grammar refuses, it refuses in words.** `hp = 3` says a stat is a float and there
  is no equality test; `act on entity` says an act on an entity names the stat it changes;
  `dist it <= 1` says `it` is what a condition hands to an action, not something a condition
  can test. These were unreachable states in the menus, so the message replaces the greyed-out
  option.
- **Text is the wire form too.** A decision's `conds` is a list of written conditions and an
  action's `act` is a string, so `behaviours/*.json` reads as the behaviour it describes;
  tuples are still accepted everywhere, indefinitely, since they cost one `isinstance` check.
  A line that does not parse is *kept* as typed, in the node and in the file, and flagged —
  a half-written condition is a state to fix, not something to silently drop or revert.

Thresholds are unchanged (decision 28): a number, or arithmetic over your own stats.

### 33. A chart may run another saved behaviour

Decision 26 said charts compose; this is how. A third node kind sits beside decision and
action:

    behaviour   runs the chart named here, then carries on at `next`

`{"type": "behaviour", "name": "eat", "next": "n5"}` — the walk steps into `behaviours/eat.json`
at its entry, and when that chart runs off the end of itself it comes back out at the calling
node's `next`. So "if something is close, fight it, otherwise eat" is written once
as two named charts and a decision between them, rather than as two copies of the same
sub-tree that then drift apart.

- **It is one tick, not two.** A call shares the caller's action budget and its `it` subject:
  a called behaviour is part of this turn. If `eat` spends the tick's one action, nothing after
  the call runs — the editor says so, in the same words it uses for a second action on a path,
  because it is the same arithmetic. The editor analyses the called chart to know what it can
  spend, so a call carries a range (`spends 0–1 actions of the tick`) rather than a guess.
- **The name is resolved once, at parse time**, against the library of decision 29. A chart in
  play carries the charts it calls rather than looking them up mid-tick, so nothing hunts for a
  file during a walk, and a saved chart on disk still holds only a name — the file stays purely
  semantic. The cost is that a chart already running in a world does not notice its parts being
  edited; saving and resetting is the loop, exactly as it already was for the chart itself.
- **A cycle is a parse error, not a hang.** A chart that would end up running itself, directly
  or round a chain, is refused where it is read — by `parse_chart`, by `/api/validate`, and by
  the editor as you pick the name. There is no recursion in behaviour and no need for one: a
  tick is one action, so a chart that called itself could only spend that action sooner.
- **A missing name is an error, not a silent nothing** (decision 9 is about bad information
  inside the sim, not about letting a broken chart into it). `saved_behaviours` skips a file
  whose call will not resolve, the way it already skips one that will not parse; deleting a
  behaviour warns which charts run it.
- **Call and insert are both offered, and they are different things.** The library's `call`
  wires in a reference — edit the named chart and every caller changes. Its older `insert`
  pastes the nodes in as a copy, which then goes its own way. Copying is sometimes what you
  want; it should not be the only thing on offer.

*Completes* decision 26's "or another flow chart".

### 34. `random` is a selector: a hex next to you

Actions name what they are about with a selector — `entity`, `it`, `+hp source`. A fourth
one names no thing at all:

    move randomly                 ("move", ("random",), 1)

`random` resolves to one of the hexes adjacent to you, drawn fresh every tick out of the
world's own rng, so a seeded world stays reproducible. It is a selector rather than a new
kind of action because a random step *is* a move toward a hex — the machinery that walks,
blocks and ties (decisions 20, 31) is unchanged, and the grammar grows by one word instead
of by a node type.

- **Only hexes on the map are drawn.** At the rim a random step is still a step, not a turn
  spent walking into the wall.
- **It is a hex, not a thing**, so `dist random` is refused (a neighbour is always one away)
  and an act aimed at one lands on whoever happens to be standing there, or on nothing —
  the same waste any blind action buys (decision 9). Gathering still needs a named source.
- **What it is for is search.** Every other selector needs something already in view; a
  chart whose senses come up empty had only `end` — stand still and starve. Now the else
  branch can look elsewhere.

Written as `move randomly` or `wander`; `move away from random` is legal too, and reads as
what it is — a step away from a hex picked at random.

### 35. Starting stats are rolled, not issued

Every entity used to open on the same numbers, so the only thing separating two of them at
tick 0 was the chart they were running. Now each stat is drawn per entity, uniformly in
whole units within a spread of `START`:

    START        = {"hp": 20, "speed": 2, "sense": 6}     # the mean of the field
    START_SPREAD = {"hp":  6, "speed": 1, "sense": 2}     # +/- this, drawn per entity

- **`START` stays the yardstick.** It is now the mean of the roll rather than everyone's
  actual opening, so everything written against it still reads true: corpse loot is a
  fraction of it (decision 10), and a generated or authored threshold like `hp < 12` still
  means roughly what it looks like it means.
- **Whole units, floored at one.** Stats come out of the wild in whole units (decision 11),
  and a birth roll should not be the one place they arrive as fractions. The floor keeps a
  bad roll from producing an entity that is born blind or already dead.
- **Speed especially must stay coarse.** A tier is a tie in effective pace (decision 31); a
  continuous draw would give every entity a tier of its own and quietly delete simultaneous
  resolution. Three speeds across the field is three tiers, which is the point of tiers.
- **Same rng, same seed.** The roll comes out of the world's own stream, next to the map
  and the spawn hexes, so a seeded world is still reproducible.

What this buys is a control: two entities on the same chart now live different lives, so a
behaviour's showing across a run is separable from the body it happened to be born into.

*Answers the "initial stats" half of open question 2.*

### 36. hp has a ceiling: the roll you were born with

`CAPPED = ("hp",)`. An entity opens at its rolled hp and that number is also the most hp it
can ever hold. It can be emptied and filled back to the top, by the wild or by another
entity's hands, and not one drop past it.

- **The cap is enforced on the way in, never by clipping afterwards.** `resolve.headroom`
  says how much room is left and `resolve.upto` trims the transfer to fit, so nothing is
  destroyed to make the number hold: a grazer at nine-tenths health takes a tenth of a unit
  out of the patch and leaves the rest in the ground, and a healer topping up a nearly-full
  target spends only what actually lands. Clipping `e.stat["hp"]` after the fact would have
  emptied the cell, burned the giver's hp, and left nobody better off. Because what leaves
  the source and what arrives are different numbers (absorption, decision 12), the trim is a
  ratio rather than a subtraction.
- **A full entity's act is wasted, and that is the honest answer.** Grazing at full health
  logs `wasted — already at full hp`, exactly like grazing an empty patch does (decision 9:
  a turn spent on nothing costs the turn). Hunger keeps running, so within a few ticks the
  bite takes hp back down and the patch is worth eating again. The loop is self-regulating,
  and a chart that would rather not spend the turn can now say so: `my hp < my.max_hp`.
- **Only hp.** Speed and sense are boons the wild grants in ones (decision 11). Capping them
  at the roll would make a boon cell worthless from tick 0, since an entity is born at its
  own ceiling — there would be nothing about yourself left to improve, and decision 11's
  non-hp half of the economy would be dead weight.
- **Being emptied has no ceiling.** A hazard cell, a blow, or the hunger bleed are never
  trimmed. The limit is on being filled.
- **The charts had to learn it.** `GRAZE` and `behaviours/eat.json` now test
  `my hp < my.max_hp` before drawing, or they spend every full-bellied turn on a wasted act
  (437 of 494 wasted turns in a 200-tick run, before the guard; 0 after). Full, the walk
  falls through to the move and the entity parks on the patch until hunger makes room.
  `behaviours/attackifhealthy.json` traded its flat `my hp > 10` for
  `my hp > my.max_hp / 2`, which is what the name meant all along.
- **A healer still cannot see the ceiling it is filling.** `their hp < their.max_hp` is not
  expressible: a threshold binds only `my` (decision 28), because a second subject would have
  to be resolved and that is not a number's job. So `behaviours/heal.json` still pours into
  full targets — ~32 wasted acts in a 200-tick run — and the cost lands on the giver's turn
  rather than its hp, since `upto` refunds what would have spilled. Fixing it properly means
  either binding the condition's subject inside its own threshold, or a condition kind that
  compares two entities directly; both are bigger than decision 28 and are not done here.

**Why.** hp was doing two jobs: how alive you are, and how much you had accumulated. The
second one ran away — a good grazer's hp climbed without bound, which made "half health"
unwritable (half of *what*?), made a fight's outcome mostly a function of who had been eating
longest, and made the wild's supply the only real currency. Capping it splits the jobs back
apart: hp is a condition you keep up, and skill (decision 15) is what you actually accumulate.

**What this costs.** A grazer can no longer bank hp against a bad stretch, so surviving a
famine is about the hunger clock rather than about a stockpile, and a long peaceful run no
longer produces a giant. Predation is worth less: killing a fat entity used to be a windfall,
and corpse loot is now the only place a large lump of hp exists at all (it is a fraction of
`START`, decision 10, so it is not capped by anybody's roll — it goes into the ground, and
whoever eats it still eats it a mouthful at a time).

### 37. A turn can be replayed, and the whole world comes back with it

The run keeps a copy of itself. Every tick, `serve.py` freezes the world — every cell's
amount, every entity's position, stats, ceilings, skill, strain, hunger, trail, and the rng
— and `/api/goto?t=N` puts that copy back. Walking back to a turn is not the map being
redrawn from the log; it is the world *being* what it was.

- **All state, or it is not a replay.** Positions alone would put the bodies in the right
  hexes over a field that never regrew, with skill and hunger belonging to a different turn.
  The log is a record of what happened, not a description of the state, and there is no
  inverse of a tick to run backwards: the cheap, honest way to have the past is to have kept
  it. So the whole world is kept, and nothing is reconstructed.
- **The rng goes with it** (decision 34: `random` targets are drawn mid-tick). Replaying a
  turn from a walked-back world plays out the turn that was played, not a new draw — which
  is what makes stepping forward off the record and re-running it indistinguishable.
- **Forward through the record, then on past it.** `tick` / `×10` / `play` replay recorded
  turns while the world is behind the head of the run, and run new ones beyond it. Because
  a re-run is identical, the only difference replaying makes is that the record survives:
  you can step back and forth over the same stretch instead of burning the future each
  time you step into it.
- **Authoring is what voids the future.** Give an entity a new chart (`/api/rules`) and
  everything recorded after the current tick belongs to a run that no longer exists, so it
  is dropped there and then. This is the point of walking back at all: park the world on the
  turn where a behaviour went wrong, change the chart, and run that turn again.
- **A log row is a moment.** Clicking one puts the world in the turn that event belongs to,
  so the actor is standing where it stood when it acted and the line to the cell it aimed at
  joins the two places it was really drawn between. Highlighting a past event against the
  present state drew the mark on a body that had since walked away — the log says what
  happened, and the map has to be showing when it happened for that to mean anything. A row
  older than the kept span still only highlights, since that state is gone.
- **The log does not shrink when you walk into it.** The turns after the one being shown
  are still listed, dimmed: you are standing in an earlier moment, not undoing a later one,
  and the record of what happened is not unwritten by looking at it. (The one thing that does
  unwrite it is authoring a chart — those turns will not happen now.) The drawer holds a
  window on the run centred on the tick being shown, and holds that tick in the middle of
  the view, so stepping back does not shove the line you clicked out from under your eye.
- **A bounded tail, not the whole history.** `HIST_CAP` ticks are kept (600), the oldest
  dropped first; the snapshot reports the span it can reach as `first`/`head`, and the
  timeline in the bar spans exactly that.

### 38. A chart has an entry, not a start node

`start` and `end` were nodes that did nothing. `end` was already the same thing as an edge
that leads nowhere — the walk's stopping condition tested both, on one line — so it was
decoration a chart had to carry and every surface had to special-case. `start` did carry one
fact, but only one: which node the walk begins at. That is a property of the chart, not a
node in it.

So the graph is now `{entry, nodes}` over three node kinds — decision, action, behaviour:

    {"entry": "n2", "nodes": {"n2": {"type": "decision", ...}}}

- **A branch finishes by leading nowhere.** `""` is how a branch says "the tick ends here",
  and it is the only way it says so. There is no second spelling, so the editor no longer
  warns you toward one — a dangling exit is the normal shape of a finished branch, not a
  thing to remark on. What it warns about instead is a branch that can spend the whole tick
  doing nothing: a call that can return having done nothing with nothing wired after it.
- **The entry is a mark you move, not an edge you rewire.** Every node is now an ordinary
  node — deletable, labellable, copyable — and one of them carries the ▸ mark. Charts saved
  before this are folded into the new shape as they are opened.
- **Two fewer kinds is two fewer everywhere.** The walk loop, the parser, the editor's node
  rendering, its copy/paste, its inliner, and the sim's own chart builder each lost a case.

*Amends* decisions 26 and 33.

## Substrate status

The `sim/` package runs the arena (`python -m sim`); `serve.py` and the `web/` assets
(`index.html` / `index.css` / `index.js`, plus the flowchart editor) serve it to a browser at
`localhost:8000` — hex map, per-entity inspector, event log, and a timeline the run can be
walked back along (decision 37). Stdlib only for now; the stack
improves as needs get larger (which stack is used is not a design decision).

The sim runs flow charts (decision 26) one action per tick, resolved in speed tiers
(decision 31). Attenuating reach and the `power` base magnitude are gone with it: reach is
the adjacency gate of decision 5, and `POWER` is 1.0. The `rules` slot-count stat is gone
with decision 27: the stats are `hp`, `speed`, `sense`, and every one of them is carried,
read, tested and traded alike. Remaining divergences: funded creation (old 17), and moving
trains nothing though decision 15 says use grows skill -- a move is one hex whoever takes it
(decision 31), so there is no magnitude for skill to scale. The `("position", sign)` key was
being earned, decayed and displayed without a single reader; it is gone until movement has a
quality worth practising.
The flat rule list and its dropdown grammar (old 14/16/21) are gone, replaced by the chart
machine, whose nodes are written as text and checked as they are typed (decision 32), whose
charts call each other by name (decision 33), and whose graph is an `entry` over decision /
action / behaviour nodes (decision 38).

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
- **30 Speed is an action budget** — replaced by 31. Budgeted speed made speed the one stat
  that mattered and let a chart do everything every tick; speed is now initiative only.
- **24 Interface hue/sign code** — not a decision; a readable UI is an engineering norm.

## Open

Roughly in the order they'll need answering:

1. **Map design** — how resources and hazards are placed, what players can do to cells, how
   movement works. (Focus 1a.)
2. **Spawn & generations** — whether and how new entities arise, what, if anything, is
   inherited. Initial stats are settled: they are rolled (decision 35).
3. **Dead characters** — what happens on death. Rebirth is wanted; the mechanism is unknown.
   Waiting on the working demo of entity interaction before this can be seen clearly.

## Process

Decisions get made one at a time and recorded here. No speculative design ahead of the
decisions.
