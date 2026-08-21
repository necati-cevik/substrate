"""Simulation tuning constants and starting stats (see DESIGN.md)."""

# ---------------------------------------------------------------- tuning
MAP_RADIUS   = 10
N_ENTITIES   = 30
TICKS        = 400

K_ABSORB     = 0.05    # decision 12
FALLOFF      = 0.35    # decision 5
POWER        = 5.0     # decision 5: flat magnitude per action (was the capacity stat)
UPKEEP_FLAT  = 0.02    # decision 13 (amended): upkeep accrues as strain, not as decay
UPKEEP_RATE  = 0.004   # ...proportional to what you carry -- the tax on the powerful
STRAIN_K     = 0.08    # how hard unpaid upkeep bites efficiency
STRAIN_DRAIN = 0.045   # hp bled per point of strain per tick
LOOT_PCT     = 0.40    # decision 10
SKILL_GAIN   = 0.06    # decision 15
SKILL_K      = 3.0
SKILL_DECAY  = 0.004
REGROW       = 0.06
READ_FRAC    = 0.5     # decision 23: stats are readable at half your sense range
RES_WEIGHTS  = [6, 2, 2]      # per PAYLOAD_STATS; the wild is mostly health
N_BLOBS      = 9

STATS  = ["hp", "speed", "sense", "rules"]   # decision 30: speed = actions per tick
# decision 25: `rules` is carried and read but never traded. The wild has no rule-slots to
# hand out, and a randomly-authored rule must not strip a rival's slot count, so `rules` is
# absent from resource payloads and from randomly-generated action targets.
PAYLOAD_STATS = ["hp", "speed", "sense"]
START  = {"hp": 20.0, "speed": 2.0, "sense": 6.0, "rules": 4.0}   # speed 2 = move-and-act

def tune(**kw):
    g = globals()
    for k, v in kw.items():
        assert k in g, k
        g[k] = v
