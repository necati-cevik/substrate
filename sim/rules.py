"""Rule validation: numeric-threshold expressions and ruleset parsing."""
import ast

from .config import STATS
from .grammar import OPS, COND_SPEC, SEL_SPEC

# ---------------------------------------------------------------- numeric thresholds
# A `num` threshold is either a literal number or an arithmetic expression over the entity's
# own stats -- e.g. "u.sense/2". Expressions are compiled once and cached, then evaluated
# against the entity each tick. `u` is the entity deciding; the stat names are the same four
# the rest of the grammar uses. A threshold that fails to evaluate is NaN, which makes every
# comparison false, so the condition simply does not fire (decision 9's spirit).
_EXPR_CACHE = {}

def _compile_expr(text):
    """text -> (e -> float). Accepts literals, u.<stat>, + - * /, parentheses and unary
    minus. Raises ValueError on anything else."""
    if text in _EXPR_CACHE:
        return _EXPR_CACHE[text]
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as ex:
        raise ValueError(f"bad expression {text!r}: {ex}")
    stats = set()
    def check(node):
        if isinstance(node, ast.Expression):
            check(node.body)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            check(node.left); check(node.right)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            check(node.operand)
        elif isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            pass
        elif (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
              and node.value.id == "u" and node.attr in STATS):
            stats.add(node.attr)
        else:
            raise ValueError(f"bad expression {text!r}")
    check(tree)

    class _Rewrite(ast.NodeTransformer):
        def visit_Attribute(self, node):
            if (isinstance(node.value, ast.Name) and node.value.id == "u"
                    and node.attr in STATS):
                return ast.copy_location(ast.Name(id="_u_" + node.attr, ctx=ast.Load()), node)
            return node
    tree = _Rewrite().visit(tree)
    ast.fix_missing_locations(tree)
    code = compile(tree, "<expr>", "eval")

    def ev(e):
        env = {"_u_" + s: e.stat[s] for s in stats}
        try:
            return float(eval(code, {"__builtins__": {}}, env))
        except (ZeroDivisionError, OverflowError):
            return float("nan")
    _EXPR_CACHE[text] = ev
    return ev

def _parse_num(v):
    if isinstance(v, bool):
        raise ValueError(f"num must be a number or an expression, got {v!r}")
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    if isinstance(v, str):
        v = v.strip()
        if not v:
            raise ValueError("num expression is empty")
        _compile_expr(v)          # validate; raises ValueError if malformed
        return v
    raise ValueError(f"num must be a number or an expression, got {v!r}")

def _num_value(num, e):
    if isinstance(num, str):
        return _compile_expr(num)(e)
    return num

def _field(kind, v):
    if kind == "stat":
        if v not in STATS:
            raise ValueError(f"not a stat: {v!r}")
        return v
    if kind == "op":
        if v not in OPS:
            raise ValueError(f"not an operator: {v!r}")
        return v
    if kind == "sign":
        if v not in (1, -1):
            raise ValueError(f"sign must be 1 or -1, got {v!r}")
        return v
    if kind == "num":
        return _parse_num(v)
    if kind == "sel":
        return _parse(SEL_SPEC, v, "selector")
    raise ValueError(f"unknown field kind {kind!r}")

def _parse(spec, v, what):
    if not isinstance(v, (list, tuple)) or not v:
        raise ValueError(f"{what}: expected [kind, ...], got {v!r}")
    kind, fields = v[0], spec.get(v[0])
    if fields is None:
        raise ValueError(f"{what}: unknown kind {kind!r}")
    if len(v) - 1 != len(fields):
        raise ValueError(f"{what} {kind}: takes {len(fields)} field(s), got {len(v) - 1}")
    return (kind,) + tuple(_field(f, x) for f, x in zip(fields, v[1:]))

def _parse_act(v):
    """An act's arity depends on its target. A source carries its own (stat, delta), so
    an act on a source names no stat/sign; against an entity or `it` it names both."""
    if not isinstance(v, (list, tuple)) or not v:
        raise ValueError("action: expected [kind, ...], got nothing")
    kind = v[0]
    if kind == "move":
        if len(v) - 1 != 2:
            raise ValueError(f"action move: takes 2 field(s), got {len(v) - 1}")
        return (kind, _parse(SEL_SPEC, v[1], "selector"), _field("sign", v[2]))
    if kind == "act":
        if len(v) - 1 < 1:
            raise ValueError("action act: takes a selector")
        sel = _parse(SEL_SPEC, v[1], "selector")
        if sel[0] == "source":
            if len(v) - 1 != 1:
                raise ValueError("action act on a source names no stat/sign (the source carries them)")
            return (kind, sel)
        if len(v) - 1 != 3:
            raise ValueError(f"action act: takes selector, stat, sign, got {len(v) - 1}")
        return (kind, sel, _field("stat", v[2]), _field("sign", v[3]))
    raise ValueError(f"action: unknown kind {kind!r}")

def parse_ruleset(v):
    """Validate a ruleset off the wire. Legal or rejected -- decision 9 is about bad
    information inside the sim, not about letting malformed rules into it."""
    if not isinstance(v, list) or not v:
        raise ValueError("ruleset must be a non-empty list")
    out = []
    for i, r in enumerate(v):
        if not isinstance(r, (list, tuple)) or len(r) != 2:
            raise ValueError(f"rule {i}: expected [conditions, action]")
        conds, act = r[0], r[1]
        if not isinstance(conds, (list, tuple)) or not conds:
            raise ValueError(f"rule {i}: conditions must be a non-empty list")
        parsed_conds = tuple(_parse(COND_SPEC, c, f"rule {i} condition {j}")
                             for j, c in enumerate(conds))
        out.append((parsed_conds, _parse_act(act)))
    return out
