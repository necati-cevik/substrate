"""Simulation tuning constants and starting stats (see DESIGN.md)."""

# ---------------------------------------------------------------- tuning
MAP_RADIUS   = 10
N_ENTITIES   = 30
TICKS        = 400

K_ABSORB     = 0.05    # decision 12
POWER        = 1.0     # decision 31: one flat unit per action, before skill and condition
UNIT         = 1.0     # the grain of the wild: a cell holds and yields whole units only
UPKEEP_FLAT  = 0.02    # decision 13 (amended): upkeep accrues as strain, not as decay
UPKEEP_RATE  = 0.004   # ...proportional to what you carry -- the tax on the powerful
STRAIN_K     = 0.08    # how hard unpaid upkeep bites efficiency
HUNGER_GRACE = 3       # turns of hunger that cost nothing -- upkeep is owed, not yet due
HUNGER_EXP   = 1.35    # each turn hungry past the grace bites this much harder
HUNGER_DRAIN = 0.15    # hp bled per unit of hunger bite -- the same curve, a separate effect
LOOT_PCT     = 0.40    # decision 10
SKILL_GAIN   = 0.06    # decision 15
SKILL_K      = 3.0
SKILL_DECAY  = 0.004
REGROW       = 0.14   # per cell per tick; a spent cell is bare until a whole unit is back
READ_FRAC    = 0.5     # decision 23: stats are readable at half your sense range
RES_WEIGHTS  = [6, 2, 2]      # per STATS; the wild is mostly health
HP_AMOUNT    = (0, 10)        # an hp patch holds 0-10 units, drawn one at a time
BOON_AMOUNT  = 1.0            # every other stat comes in ones: a speed+ cell is one point
N_BLOBS      = 30             # cells are small now, so the map needs many more of them
ACTS_PER_TICK = 1      # decision 31: a chart walk stops at its first action

# decision 27: there is no capability stat. Every stat is carried, read, tested and traded
# alike -- what a chart may do is not rationed by a number.
STATS  = ["hp", "speed", "sense"]   # decision 31: speed = initiative, not a budget
# decision 36: stats with a ceiling. What you were rolled with is the most you can hold, so
# hp is a condition to keep up rather than a hoard to grow. Only hp: speed and sense are
# boons the wild grants in ones (decision 11), and capping them at the roll would make a
# boon cell worthless from tick 0 -- there would be nothing about yourself left to improve.
CAPPED = ("hp",)
START  = {"hp": 20.0, "speed": 2.0, "sense": 6.0}   # the mean of the field, and the yardstick
START_SPREAD = {"hp": 6, "speed": 1, "sense": 2}    # +/- this many whole units, drawn per entity

def tune(**kw):
    g = globals()
    for k, v in kw.items():
        assert k in g, k
        g[k] = v
