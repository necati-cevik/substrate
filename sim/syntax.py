"""Text surface for the condition/action grammar (decision 32).

The vocabulary is the same one `sim/grammar.py` states as data; this module is only its
written form, so a chart can be authored by typing

    my hp < 10                     ("self", "hp", "<", 10)
    my hp > my.max_hp / 2          ("self", "hp", ">", "my.max_hp / 2")
    their speed >= u.speed         ("other", "speed", ">=", "u.speed")
    dist +hp source <= 1           ("dist_source", "hp", 1, "<=", 1)
    amount +hp source > 0          ("amount", "hp", 1, ">", 0)
    count entities > 2             ("count_entity", ">", 2)
    always                         ("always",)

    move toward +hp source         ("move", ("source", "hp", 1), 1)
    move away from entity          ("move", ("entity",), -1)
    move randomly                  ("move", ("random",), 1)
    act on +hp source              ("act", ("source", "hp", 1))
    act -hp on it                  ("act", ("it",), "hp", -1)

instead of assembled from menus. Every parse ends by handing its tuple back through
`sim/rules.py`, so text can express exactly what the menus could and nothing else -- the
written form is a surface, never a second grammar to keep in step.

Errors carry a position, so an editor can point at the word it choked on: `TextError.at`
is an offset into the source, `.len` the length of the offending token, and `.expected`
the words that would have been legal there.
"""
import re

from .config import STATS
from .grammar import OPS, COND_SPEC
from .rules import _parse, _parse_act, _parse_num

class TextError(ValueError):
    """A parse failure with a place to point at."""
    def __init__(self, msg, at=0, length=1, expected=()):
        super().__init__(msg)
        self.msg, self.at, self.len, self.expected = msg, at, length, tuple(expected)

    def caret(self, src):
        """The message with the source and a caret under the offending token -- what a
        terminal shows and an editor's tooltip can fall back to."""
        return f"{src}\n{' ' * self.at}{'^' * max(1, self.len)}\n{self.msg}"

    def shift(self, n):
        """The same error, relocated -- used when a chunk was cut out of a larger text."""
        return TextError(self.msg, self.at + n, self.len, self.expected)

# ---------------------------------------------------------------- words
# Keywords are grouped by what they introduce, so an error can list the alternatives that
# were open at that point instead of naming the one branch that happened to be tried last.
SELF_W    = ("my", "own", "i")
OTHER_W   = ("their", "other", "its")
DIST_W    = ("dist", "distance")
COUNT_W   = ("count", "n")
AMOUNT_W  = ("amount", "left")
ENTITY_W  = ("entity", "entities", "body", "one")
IT_W      = ("it", "them")
SOURCE_W  = ("source", "cell", "patch")     # optional noun after `+hp`
RANDOM_W  = ("random", "randomly", "anywhere", "wander", "roam")
HEX_W     = ("hex", "cell", "neighbour", "neighbor", "direction", "way")  # optional after `random`
NEAR_W    = ("nearest", "closest", "the", "a")
MOVE_W    = ("move", "step", "go")
TOWARD_W  = ("toward", "towards", "to", "at")
AWAY_W    = ("away", "off")
GATHER_W  = ("gather", "draw", "take", "eat")
ACT_W     = ("act", "use", "apply", "hit")
ON_W      = ("on", "against", "onto")

_WORD = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
_OP   = re.compile(r"<=|>=|<|>|==|=")
_NUM  = re.compile(r"\d+\.?\d*|\.\d+")

def _lex(src):
    """(kind, text, at) triples. `num` is not lexed as a value: a threshold is always the
    tail of the line, so it is taken from the raw source and handed to rules.py whole --
    that way `u.sense/2` needs no arithmetic grammar here."""
    out, i = [], 0
    while i < len(src):
        c = src[i]
        if c.isspace():
            i += 1
            continue
        m = _WORD.match(src, i)
        if m:
            out.append(("w", m.group().lower(), i))
            i = m.end()
            continue
        m = _OP.match(src, i)
        if m:
            out.append(("op", m.group(), i))
            i = m.end()
            continue
        m = _NUM.match(src, i)
        if m:
            out.append(("n", m.group(), i))
            i = m.end()
            continue
        if c in "+-":
            out.append(("sign", c, i))
            i += 1
            continue
        if c in "()":
            out.append((c, c, i))
            i += 1
            continue
        # anything else is kept as an opaque token rather than refused here: the tail of
        # a line is a threshold expression (`u.sense/2`), which rules.py parses, not us.
        out.append(("x", c, i))
        i += 1
    return out

# ---------------------------------------------------------------- parser
class _P:
    def __init__(self, src):
        self.src = src
        self.t = _lex(src)
        self.i = 0
        self.end = 0                    # source offset just past the last token taken

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def done(self):
        return self.i >= len(self.t)

    def _take(self):
        tk = self.t[self.i]
        self.i += 1
        self.end = tk[2] + len(tk[1])
        return tk

    def word(self, *words):
        """Take the next token if it is one of these words, else leave it and return None."""
        tk = self.peek()
        if tk and tk[0] == "w" and tk[1] in words:
            self._take()
            return tk[1]
        return None

    def dot(self):
        """An optional `.` after the subject. `my hp` and `my.hp` are the same condition:
        the dotted form is how a threshold expression names the same stat (`my.max_hp/2`),
        so the two halves of a line read alike instead of each in its own dialect."""
        tk = self.peek()
        if tk and tk[0] == "x" and tk[1] == ".":
            self._take()
            return True
        return False

    def fail(self, want, expected=()):
        tk = self.peek()
        if tk is None:
            raise TextError(f"expected {want}, but the line ends", len(self.src), 1, expected)
        raise TextError(f"expected {want}, got {tk[1]!r}", tk[2], len(tk[1]), expected)

    def op(self):
        tk = self.peek()
        if tk and tk[0] == "op":
            self._take()
            if tk[1] in ("=", "=="):
                raise TextError("there is no equality test -- a stat is a float, so compare "
                                "with < > <= >=", tk[2], len(tk[1]), tuple(OPS))
            return tk[1]
        self.fail("a comparator (< > <= >=)", tuple(OPS))

    def stat(self):
        tk = self.peek()
        if tk and tk[0] == "w" and tk[1] in STATS:
            self._take()
            return tk[1]
        self.fail("a stat", STATS)

    def sign(self):
        tk = self.peek()
        if tk and tk[0] == "sign":
            self._take()
            return 1 if tk[1] == "+" else -1
        self.fail("+ or - (which way the source or the act runs)", ("+", "-"))

    def num(self):
        """Everything left on the line is the threshold -- a number or an expression over
        your own stats (decision 28)."""
        text = self.src[self.end:]
        at = self.end + (len(text) - len(text.lstrip()))
        text = text.strip()
        if not text:
            raise TextError("expected a threshold: a number, or arithmetic over your own "
                            "stats like my.sense/2 or my.max_hp/2", len(self.src), 1)
        self.i = len(self.t)
        self.end = len(self.src)
        try:
            return _parse_num(float(text))          # a plain number stays a number
        except ValueError:
            pass
        try:
            return _parse_num(text)                 # ...otherwise an expression, as written
        except ValueError as ex:
            raise TextError(str(ex), at, len(text)) from None

    def finish(self, value):
        if not self.done():
            tk = self.peek()
            raise TextError(f"{self.src[tk[2]:]!r} is left over", tk[2], len(self.src) - tk[2])
        return value

def _selector(p, what="a target"):
    """entity | it | +hp source -- optionally wrapped in parens, as the readable form
    prints it (`dist(+hp source)`)."""
    if p.peek() and p.peek()[0] == "(":
        p._take()
        sel = _selector(p, what)
        if not (p.peek() and p.peek()[0] == ")"):
            p.fail("`)`", (")",))
        p._take()
        return sel
    p.word(*NEAR_W)                     # `nearest` is how it reads, not a choice: it is
    if p.word(*IT_W):                   # always the nearest one (sim/sense.py)
        return ("it",)
    if p.word(*RANDOM_W):               # decision 34: a hex next to you, not a thing
        p.word(*HEX_W)                  # the noun is optional: `random` says it already
        return ("random",)
    if p.word(*ENTITY_W):
        return ("entity",)
    tk = p.peek()
    if tk and tk[0] == "sign":
        sign = p.sign()
        stat = p.stat()
        p.word(*SOURCE_W)               # the noun is optional: `+hp` says it already
        return ("source", stat, sign)
    p.fail(f"{what}: `entity`, `it`, `random`, or a source like `+hp source`",
           ENTITY_W[:1] + IT_W[:1] + RANDOM_W[:1] + ("+", "-"))

def _condition(p):
    if p.word("always"):
        return ("always",)
    if p.word(*DIST_W):
        sel = _selector(p, "what to measure to")
        op, num = p.op(), p.num()
        if sel[0] == "entity":
            return ("dist_entity", op, num)
        if sel[0] == "source":
            return ("dist_source", sel[1], sel[2], op, num)
        if sel[0] == "random":
            raise TextError("a random hex is always one step away -- there is nothing to "
                            "measure to", 0, len(p.src))
        raise TextError("`it` is what a condition hands to an action, so a condition "
                        "cannot test it", 0, len(p.src))
    if p.word(*COUNT_W):
        paren = bool(p.peek() and p.peek()[0] == "(")
        if paren:
            p._take()
        p.word(*NEAR_W)
        if not p.word(*ENTITY_W):
            p.fail("`entities` -- counting is only ever of entities in sight", ENTITY_W[:2])
        if paren:
            if not (p.peek() and p.peek()[0] == ")"):
                p.fail("`)`", (")",))
            p._take()
        return ("count_entity", p.op(), p.num())
    if p.word(*AMOUNT_W):
        sel = _selector(p, "which source")
        if sel[0] != "source":
            raise TextError("`amount` is about a source -- try `amount +hp source > 0`",
                            0, len(p.src))
        op, num = p.op(), p.num()
        return ("amount", sel[1], sel[2], op, num)
    who = p.word(*(SELF_W + OTHER_W))
    tk = p.peek()
    if who is None and not (tk and tk[0] == "w" and tk[1] in STATS):
        p.fail("a condition: `my hp < 10`, `their hp < 10`, `dist entity <= 1`, "
               "`count entities > 2`, `amount +hp source > 0`, or `always`",
               ("always",) + SELF_W[:1] + OTHER_W[:1] + DIST_W[:1] + COUNT_W[:1]
               + AMOUNT_W[:1] + tuple(STATS))
    p.dot()                             # `my.hp` reads the same as `my hp`
    kind = "other" if who in OTHER_W else "self"
    stat = p.stat()
    return (kind, stat, p.op(), p.num())

def _action(p):
    if p.word(*RANDOM_W):               # `wander` on its own -- `move randomly` in one word
        p.word(*HEX_W)
        return ("move", ("random",), 1)
    if p.word(*MOVE_W):
        if p.word(*RANDOM_W):           # `move randomly`: no direction to be toward or away from
            p.word(*HEX_W)
            return ("move", ("random",), 1)
        if p.word(*TOWARD_W):
            sign = 1
        elif p.word(*AWAY_W) or p.word("from"):
            p.word("from")
            sign = -1
        else:
            p.fail("`toward`, `away from`, or `randomly`",
                   TOWARD_W[:1] + ("away from", "randomly"))
        return ("move", _selector(p, "what to move relative to"), sign)
    if p.word(*GATHER_W):
        sel = _selector(p, "which source")
        if sel[0] != "source":
            raise TextError("only a source can be gathered from; against an entity name "
                            "the stat: `act +hp on entity`", 0, len(p.src))
        return ("act", sel)
    if p.word(*ACT_W):
        if p.word(*ON_W):
            sel = _selector(p, "which source")
            if sel[0] != "source":
                # decision 22: what an act does to an entity is not implied by the entity
                raise TextError("an act on an entity names the stat it changes: "
                                "`act +hp on entity`", 0, len(p.src))
            return ("act", sel)
        sign = p.sign()
        stat = p.stat()
        if not p.word(*ON_W):
            p.fail("`on`, then what to act on", ON_W[:1])
        sel = _selector(p, "what to act on")
        if sel[0] == "source":
            raise TextError("an act on a source names no stat/sign (the source carries "
                            "them) -- write `act on +hp source`", 0, len(p.src))
        return ("act", sel, stat, sign)
    p.fail("an action: `move toward +hp source`, `move away from entity`, "
           "`move randomly`, `act on +hp source`, or `act +hp on entity`",
           MOVE_W[:1] + ACT_W[:1] + GATHER_W[:1] + ("wander",))

# ---------------------------------------------------------------- public
def parse_cond(text):
    """One written condition -> the tuple the sim tests. Raises TextError."""
    p = _P(text)
    if p.done():
        raise TextError("a condition, please -- `always` if it should always hold", 0, 1)
    return _parse(COND_SPEC, p.finish(_condition(p)), "condition")

def parse_act(text):
    """One written action -> the tuple the sim carries out. Raises TextError."""
    p = _P(text)
    if p.done():
        raise TextError("an action, please -- e.g. `move toward +hp source`", 0, 1)
    return _parse_act(p.finish(_action(p)))

_SPLIT = re.compile(r"\n|\band\b|;|,|&&")

def parse_conds(text):
    """A decision's whole test: conditions one per line, or joined by `and` on one line.
    All of them must hold (sim/sense.py's AND). Blank lines are nothing, not `always`."""
    out, spans, pos = [], [], 0
    for m in _SPLIT.finditer(text):
        spans.append((pos, m.start()))
        pos = m.end()
    spans.append((pos, len(text)))
    for a, b in spans:
        chunk = text[a:b]
        if not chunk.strip():
            continue
        try:
            out.append(parse_cond(chunk))
        except TextError as ex:
            raise ex.shift(a) from None
    if not out:
        raise TextError("a decision needs at least one condition", 0, max(1, len(text)))
    return tuple(out)

# ---------------------------------------------------------------- written form
# The inverse: the canonical way to write a tuple, so a chart built any other way can be
# opened as text and typed over.
def sel_text(sel):
    if not sel:
        return "?"
    if sel[0] == "it":
        return "it"
    if sel[0] == "entity":
        return "entity"
    if sel[0] == "random":
        return "a random hex"
    return f"{'+' if sel[2] > 0 else '-'}{sel[1]} source"

def _n(v):
    """A threshold as it should be typed: an expression verbatim, a number without a
    pointless `.0`."""
    return v if isinstance(v, str) else f"{v:g}"

def cond_text(c):
    k = c[0] if c else None
    if k == "always":
        return "always"
    if k == "self":
        return f"my {c[1]} {c[2]} {_n(c[3])}"
    if k == "other":
        return f"their {c[1]} {c[2]} {_n(c[3])}"
    if k == "dist_entity":
        return f"dist entity {c[1]} {_n(c[2])}"
    if k == "dist_source":
        return f"dist {sel_text(('source', c[1], c[2]))} {c[3]} {_n(c[4])}"
    if k == "count_entity":
        return f"count entities {c[1]} {_n(c[2])}"
    if k == "amount":
        return f"amount {sel_text(('source', c[1], c[2]))} {c[3]} {_n(c[4])}"
    return str(c)

def conds_text(conds):
    return "\n".join(cond_text(c) for c in (conds or ()))

def act_text(a):
    if not a:
        return "?"
    if a[0] == "move":
        if a[1] and a[1][0] == "random" and a[2] > 0:
            return "move randomly"      # `toward a random hex` is just a random step
        return f"move {'toward' if a[2] > 0 else 'away from'} {sel_text(a[1])}"
    if a[0] == "act":
        if a[1] and a[1][0] == "source":
            return f"act on {sel_text(a[1])}"
        return f"act {'+' if a[3] > 0 else '-'}{a[2]} on {sel_text(a[1])}"
    return str(a)

def check(text, kind="cond"):
    """The syntax checker as one call: None when the text is legal, else the TextError.
    `kind` is "cond", "conds" or "act"."""
    fn = {"cond": parse_cond, "conds": parse_conds, "act": parse_act}[kind]
    try:
        fn(text)
        return None
    except TextError as ex:
        return ex
    except ValueError as ex:                    # rules.py's own verdict, without a place
        return TextError(str(ex), 0, max(1, len(text)))
