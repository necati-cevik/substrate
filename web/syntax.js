/* The written form of the condition/action grammar — the mirror of sim/syntax.py.
 *
 * A condition or an action is typed, not assembled:
 *
 *     my hp < 10                 ['self', 'hp', '<', 10]
 *     my hp > my.max_hp / 2      ['self', 'hp', '>', 'my.max_hp / 2']
 *     their speed >= u.speed     ['other', 'speed', '>=', 'u.speed']
 *     dist +hp source <= 1       ['dist_source', 'hp', 1, '<=', 1]
 *     amount +hp source > 0      ['amount', 'hp', 1, '>', 0]
 *     count entities > 2         ['count_entity', '>', 2]
 *     always                     ['always']
 *
 *     move toward +hp source     ['move', ['source', 'hp', 1], 1]
 *     move away from entity      ['move', ['entity'], -1]
 *     move randomly              ['move', ['random'], 1]
 *     act on +hp source          ['act', ['source', 'hp', 1]]
 *     act -hp on it              ['act', ['it'], 'hp', -1]
 *
 * The parser is here rather than in the editor because the checker is the point: a parse
 * failure carries `at` (an offset into the text), `len` (how much of it is wrong) and
 * `expected` (the words that would have been legal), so the editor can underline the word
 * and offer the alternatives instead of saying "invalid".
 *
 * The vocabulary itself is the sim's, handed over with `ChartSyntax.use(grammar)`; without
 * it the fallback below keeps `file://` use honest.
 */
(function (global) {
  'use strict';

  let G = { stats: ['hp', 'speed', 'sense'], ops: ['<', '>', '<=', '>='],
            start: { hp: 20, speed: 2, sense: 6 }, capped: ['hp'] };
  const capped = () => G.capped || [];   // decision 36: the stats that have a `max_`
  const use = g => { if (g && g.stats && g.ops) G = g; };

  // ---------------------------------------------------------------- thresholds
  // A mirror of sim/rules.py's whitelist (decision 28): literals, `u.<stat>` / `my.<stat>`,
  // `my.max_<stat>` for a stat that has a ceiling (decision 36), + - * /, parentheses and
  // unary minus — nothing else. A threshold is the tail of a line, so it is handed here
  // whole instead of being lexed with the rest.
  function compileExpr(text) {
    const s = String(text);
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function primary() {
      ws();
      if (s[i] === '(') {
        i++;
        const v = sum();
        ws();
        if (s[i] !== ')') throw new Error('unclosed (');
        i++;
        return v;
      }
      if (s[i] === '-') { i++; const v = primary(); return st => -v(st); }
      if (s[i] === '+') { i++; return primary(); }
      const num = /^(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (num) { i += num[0].length; const n = parseFloat(num[0]); return () => n; }
      const nm = /^(?:u|my)\.([A-Za-z_]\w*)/.exec(s.slice(i));
      if (nm) {
        i += nm[0].length;
        const k = nm[1];
        if (G.stats.indexOf(k) >= 0) return st => (st && st[k] !== undefined ? st[k] : NaN);
        // `max_<stat>`: the opening roll. A stat object without one falls back to the
        // stat as it stands, the same way sim/rules.py does for an entity without a roll.
        const base = k.slice(4);
        if (k.slice(0, 4) === 'max_') {
          if (capped().indexOf(base) >= 0)
            return st => (!st ? NaN : st[k] !== undefined ? st[k]
                                : st[base] !== undefined ? st[base] : NaN);
          throw new Error(G.stats.indexOf(base) >= 0
            ? base + ' has no ceiling — only ' + capped().join(', ') + ' can be filled up'
            : nm[0] + ' is not a stat');
        }
        throw new Error(nm[0] + ' is not a stat');
      }
      const word = /^[A-Za-z_][\w.]*/.exec(s.slice(i));
      if (word) throw new Error('only my.<stat> and my.max_<stat> may be named, not ' + word[0]);
      throw new Error(i >= s.length ? 'ends early' : 'unexpected ' + JSON.stringify(s[i]));
    }
    function prod() {
      let v = primary();
      for (;;) {
        ws();
        const c = s[i];
        if (c !== '*' && c !== '/') return v;
        i++;
        const a = v, b = primary();
        v = c === '*' ? st => a(st) * b(st) : st => a(st) / b(st);
      }
    }
    function sum() {
      let v = prod();
      for (;;) {
        ws();
        const c = s[i];
        if (c !== '+' && c !== '-') return v;
        i++;
        const a = v, b = prod();
        v = c === '+' ? st => a(st) + b(st) : st => a(st) - b(st);
      }
    }
    if (!s.trim()) throw new Error('empty');
    const f = sum();
    ws();
    if (i < s.length) throw new Error('trailing ' + JSON.stringify(s.slice(i)));
    return f;
  }
  function numError(v) {                    // null when the threshold is legal
    if (typeof v === 'number') return Number.isFinite(v) ? null : 'not a finite number';
    if (typeof v !== 'string') return 'not a number or expression';
    try { compileExpr(v); return null; } catch (ex) { return ex.message; }
  }
  function startStats() {                   // the yardstick entity: it is born full, so a
    const st = Object.assign({}, G.start);  // capped stat and its ceiling are one number
    capped().forEach(k => { st['max_' + k] = G.start[k]; });
    return st;
  }
  function numPreview(v) {                  // an expression's value at the starting stats
    if (typeof v !== 'string') return null;
    try {
      const n = compileExpr(v)(startStats());
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
    } catch (ex) { return null; }
  }
  const PLAIN = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;
  function parseNum(text) {                 // a number stays a number; anything else is
    const t = String(text).trim();          // an expression, kept as written
    if (PLAIN.test(t)) return Math.round(parseFloat(t) * 100) / 100;
    compileExpr(t);                         // throws if malformed
    return t;
  }

  // ---------------------------------------------------------------- words
  const SELF_W   = ['my', 'own', 'i'],        OTHER_W  = ['their', 'other', 'its'];
  const DIST_W   = ['dist', 'distance'],      COUNT_W  = ['count', 'n'];
  const AMOUNT_W = ['amount', 'left'],        ENTITY_W = ['entity', 'entities', 'body', 'one'];
  const IT_W     = ['it', 'them'],            SOURCE_W = ['source', 'cell', 'patch'];
  const NEAR_W   = ['nearest', 'closest', 'the', 'a'];
  const RANDOM_W = ['random', 'randomly', 'anywhere', 'wander', 'roam'];
  const HEX_W    = ['hex', 'cell', 'neighbour', 'neighbor', 'direction', 'way'];
  const MOVE_W   = ['move', 'step', 'go'],    TOWARD_W = ['toward', 'towards', 'to', 'at'];
  const AWAY_W   = ['away', 'off'],           GATHER_W = ['gather', 'draw', 'take', 'eat'];
  const ACT_W    = ['act', 'use', 'apply', 'hit'], ON_W = ['on', 'against', 'onto'];

  function TextError(msg, at, len, expected) {
    return { msg: msg, at: at || 0, len: Math.max(1, len || 1), expected: expected || [] };
  }
  const shift = (e, n) => TextError(e.msg, e.at + n, e.len, e.expected);

  const W = /^[A-Za-z_]\w*/, OPRE = /^(?:<=|>=|<|>|==|=)/, NRE = /^(?:\d+\.?\d*|\.\d+)/;

  function lex(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const rest = src.slice(i);
      if (/\s/.test(src[i])) { i++; continue; }
      let m = W.exec(rest);
      if (m) { out.push(['w', m[0].toLowerCase(), i]); i += m[0].length; continue; }
      m = OPRE.exec(rest);
      if (m) { out.push(['op', m[0], i]); i += m[0].length; continue; }
      m = NRE.exec(rest);
      if (m) { out.push(['n', m[0], i]); i += m[0].length; continue; }
      if (src[i] === '+' || src[i] === '-') { out.push(['sign', src[i], i]); i++; continue; }
      if (src[i] === '(' || src[i] === ')') { out.push([src[i], src[i], i]); i++; continue; }
      out.push(['x', src[i], i]);      // opaque: only a threshold's own characters get here
      i++;
    }
    return out;
  }

  class P {
    constructor(src) { this.src = src; this.t = lex(src); this.i = 0; this.end = 0; }
    peek() { return this.i < this.t.length ? this.t[this.i] : null; }
    done() { return this.i >= this.t.length; }
    take() { const tk = this.t[this.i++]; this.end = tk[2] + tk[1].length; return tk; }
    word(words) {
      const tk = this.peek();
      if (tk && tk[0] === 'w' && words.indexOf(tk[1]) >= 0) { this.take(); return tk[1]; }
      return null;
    }
    dot() {                     // optional `.` after the subject: `my.hp` is `my hp`, so
      const tk = this.peek();   // both halves of a line name a stat the same way
      if (tk && tk[0] === 'x' && tk[1] === '.') { this.take(); return true; }
      return false;
    }
    fail(want, expected) {
      const tk = this.peek();
      if (!tk) throw TextError('expected ' + want + ', but the line ends', this.src.length, 1, expected);
      throw TextError('expected ' + want + ', got ' + JSON.stringify(tk[1]), tk[2], tk[1].length, expected);
    }
    op() {
      const tk = this.peek();
      if (tk && tk[0] === 'op') {
        this.take();
        if (tk[1] === '=' || tk[1] === '==')
          throw TextError('there is no equality test — a stat is a float, so compare with < > <= >=',
                          tk[2], tk[1].length, G.ops);
        if (G.ops.indexOf(tk[1]) < 0) throw TextError('not an operator: ' + tk[1], tk[2], tk[1].length, G.ops);
        return tk[1];
      }
      this.fail('a comparator (< > <= >=)', G.ops);
    }
    stat() {
      const tk = this.peek();
      if (tk && tk[0] === 'w' && G.stats.indexOf(tk[1]) >= 0) { this.take(); return tk[1]; }
      this.fail('a stat', G.stats);
    }
    sign() {
      const tk = this.peek();
      if (tk && tk[0] === 'sign') { this.take(); return tk[1] === '+' ? 1 : -1; }
      this.fail('+ or − (which way the source or the act runs)', ['+', '-']);
    }
    num() {
      const raw = this.src.slice(this.end);
      const at = this.end + (raw.length - raw.replace(/^\s+/, '').length);
      const text = raw.trim();
      if (!text)
        throw TextError('expected a threshold: a number, or arithmetic over your own stats like my.sense/2 or my.max_hp/2',
                        this.src.length, 1, []);
      this.i = this.t.length;
      this.end = this.src.length;
      try { return parseNum(text); }
      catch (ex) { throw TextError(ex.message, at, text.length, []); }
    }
    finish(v) {
      if (!this.done()) {
        const tk = this.peek();
        throw TextError(JSON.stringify(this.src.slice(tk[2])) + ' is left over',
                        tk[2], this.src.length - tk[2], []);
      }
      return v;
    }
  }

  function selector(p, what) {
    if (p.peek() && p.peek()[0] === '(') {
      p.take();
      const sel = selector(p, what);
      if (!(p.peek() && p.peek()[0] === ')')) p.fail('`)`', [')']);
      p.take();
      return sel;
    }
    p.word(NEAR_W);                       // `nearest` is how it reads, not a choice: the
    if (p.word(IT_W)) return ['it'];      // sim always resolves the nearest one
    if (p.word(ENTITY_W)) return ['entity'];
    if (p.word(RANDOM_W)) {               // decision 34: a hex next to you, not a thing
      p.word(HEX_W);                      // the noun is optional: `random` says it already
      return ['random'];
    }
    if (p.peek() && p.peek()[0] === 'sign') {
      const sign = p.sign(), stat = p.stat();
      p.word(SOURCE_W);                   // the noun is optional: `+hp` says it already
      return ['source', stat, sign];
    }
    p.fail(what + ': `entity`, `it`, `random`, or a source like `+hp source`',
           ['entity', 'it', 'random', '+', '-']);
  }

  function condition(p) {
    if (p.word(['always'])) return ['always'];
    if (p.word(DIST_W)) {
      const sel = selector(p, 'what to measure to');
      const op = p.op(), num = p.num();
      if (sel[0] === 'entity') return ['dist_entity', op, num];
      if (sel[0] === 'source') return ['dist_source', sel[1], sel[2], op, num];
      if (sel[0] === 'random')
        throw TextError('a random hex is always one step away — there is nothing to measure to',
                        0, p.src.length, []);
      throw TextError('`it` is what a condition hands to an action, so a condition cannot test it',
                      0, p.src.length, []);
    }
    if (p.word(COUNT_W)) {
      const paren = !!(p.peek() && p.peek()[0] === '(');
      if (paren) p.take();
      p.word(NEAR_W);
      if (!p.word(ENTITY_W)) p.fail('`entities` — counting is only ever of entities in sight',
                                    ENTITY_W.slice(0, 2));
      if (paren) {
        if (!(p.peek() && p.peek()[0] === ')')) p.fail('`)`', [')']);
        p.take();
      }
      return ['count_entity', p.op(), p.num()];
    }
    if (p.word(AMOUNT_W)) {
      const sel = selector(p, 'which source');
      if (sel[0] !== 'source')
        throw TextError('`amount` is about a source — try `amount +hp source > 0`', 0, p.src.length, []);
      const op = p.op();
      return ['amount', sel[1], sel[2], op, p.num()];
    }
    const who = p.word(SELF_W.concat(OTHER_W));
    const tk = p.peek();
    if (!who && !(tk && tk[0] === 'w' && G.stats.indexOf(tk[1]) >= 0))
      p.fail('a condition: `my hp < 10`, `their hp < 10`, `dist entity <= 1`, '
             + '`count entities > 2`, `amount +hp source > 0`, or `always`',
             ['always', 'my', 'their', 'dist', 'count', 'amount'].concat(G.stats));
    p.dot();                            // `my.hp` reads the same as `my hp`
    const kind = OTHER_W.indexOf(who) >= 0 ? 'other' : 'self';
    const stat = p.stat(), op = p.op();
    return [kind, stat, op, p.num()];
  }

  function action(p) {
    if (p.word(RANDOM_W)) {               // `wander` on its own — `move randomly` in one word
      p.word(HEX_W);
      return ['move', ['random'], 1];
    }
    if (p.word(MOVE_W)) {
      let sign;
      if (p.word(RANDOM_W)) {             // `move randomly`: no direction to be toward or away from
        p.word(HEX_W);
        return ['move', ['random'], 1];
      }
      if (p.word(TOWARD_W)) sign = 1;
      else if (p.word(AWAY_W) || p.word(['from'])) { p.word(['from']); sign = -1; }
      else p.fail('`toward`, `away from`, or `randomly`', ['toward', 'away from', 'randomly']);
      return ['move', selector(p, 'what to move relative to'), sign];
    }
    if (p.word(GATHER_W)) {
      const sel = selector(p, 'which source');
      if (sel[0] !== 'source')
        throw TextError('only a source can be gathered from; against an entity name the stat: '
                        + '`act +hp on entity`', 0, p.src.length, []);
      return ['act', sel];
    }
    if (p.word(ACT_W)) {
      if (p.word(ON_W)) {
        const sel = selector(p, 'which source');
        if (sel[0] !== 'source')
          throw TextError('an act on an entity names the stat it changes: `act +hp on entity`',
                          0, p.src.length, []);
        return ['act', sel];
      }
      const sign = p.sign(), stat = p.stat();
      if (!p.word(ON_W)) p.fail('`on`, then what to act on', ['on']);
      const sel = selector(p, 'what to act on');
      if (sel[0] === 'source')
        throw TextError('an act on a source names no stat/sign (the source carries them) — '
                        + 'write `act on +hp source`', 0, p.src.length, []);
      return ['act', sel, stat, sign];
    }
    p.fail('an action: `move toward +hp source`, `move away from entity`, `move randomly`, '
           + '`act on +hp source`, or `act +hp on entity`', ['move', 'act', 'gather', 'wander']);
  }

  // ---------------------------------------------------------------- public
  function parseCond(text) {
    const p = new P(String(text));
    if (p.done()) throw TextError('a condition, please — `always` if it should always hold', 0, 1,
                                  ['always', 'my', 'their', 'dist', 'count', 'amount']);
    return p.finish(condition(p));
  }
  function parseAct(text) {
    const p = new P(String(text));
    if (p.done()) throw TextError('an action, please — e.g. `move toward +hp source`', 0, 1,
                                  ['move', 'act', 'gather', 'wander']);
    return p.finish(action(p));
  }
  const SPLIT = /\n|\band\b|;|,|&&/g;
  function spansOf(text) {                   // the chunks one decision's text splits into
    const out = [];
    let pos = 0, m;
    SPLIT.lastIndex = 0;
    while ((m = SPLIT.exec(text))) { out.push([pos, m.index]); pos = m.index + m[0].length; }
    out.push([pos, text.length]);
    return out.filter(([a, b]) => text.slice(a, b).trim());
  }
  function parseConds(text) {
    const out = [];
    for (const [a, b] of spansOf(String(text))) {
      try { out.push(parseCond(text.slice(a, b))); }
      catch (ex) { throw shift(ex, a); }
    }
    if (!out.length) throw TextError('a decision needs at least one condition', 0,
                                     Math.max(1, String(text).length), ['always']);
    return out;
  }

  // ---- the inverse: how a tuple should be typed, so any chart opens as text
  const n = v => (typeof v === 'string' ? v : String(Math.round(v * 100) / 100));
  function selText(sl) {
    if (!sl) return '?';
    if (sl[0] === 'it') return 'it';
    if (sl[0] === 'entity') return 'entity';
    if (sl[0] === 'random') return 'a random hex';
    return (sl[2] > 0 ? '+' : '-') + sl[1] + ' source';
  }
  function condText(c) {
    switch (c && c[0]) {
      case 'always':       return 'always';
      case 'self':         return `my ${c[1]} ${c[2]} ${n(c[3])}`;
      case 'other':        return `their ${c[1]} ${c[2]} ${n(c[3])}`;
      case 'dist_entity':  return `dist entity ${c[1]} ${n(c[2])}`;
      case 'dist_source':  return `dist ${selText(['source', c[1], c[2]])} ${c[3]} ${n(c[4])}`;
      case 'count_entity': return `count entities ${c[1]} ${n(c[2])}`;
      case 'amount':       return `amount ${selText(['source', c[1], c[2]])} ${c[3]} ${n(c[4])}`;
    }
    return typeof c === 'string' ? c : JSON.stringify(c);
  }
  function actText(a) {
    if (!a) return '?';
    if (typeof a === 'string') return a;
    if (a[0] === 'move') {
      if (a[1] && a[1][0] === 'random' && a[2] > 0) return 'move randomly';
      return `move ${a[2] > 0 ? 'toward' : 'away from'} ${selText(a[1])}`;
    }
    if (a[0] === 'act') {
      if (a[1] && a[1][0] === 'source') return `act on ${selText(a[1])}`;
      return `act ${a[3] > 0 ? '+' : '-'}${a[2]} on ${selText(a[1])}`;
    }
    return JSON.stringify(a);
  }
  const condsText = cs => (cs || []).map(condText).join('\n');

  // The checker as one call: null when the text is legal, else {msg, at, len, expected}.
  function check(text, kind) {
    const fn = kind === 'act' ? parseAct : kind === 'conds' ? parseConds : parseCond;
    try { fn(text); return null; }
    catch (ex) { return ex.msg ? ex : TextError(ex.message || String(ex), 0, String(text).length, []); }
  }
  // The parse or the error, whichever happened — what an editor wants in one go.
  function parse(text, kind) {
    const fn = kind === 'act' ? parseAct : kind === 'conds' ? parseConds : parseCond;
    try { return { value: fn(text) }; }
    catch (ex) { return { error: ex.msg ? ex : TextError(ex.message || String(ex), 0, String(text).length, []) }; }
  }

  global.ChartSyntax = { use, parse, check, parseCond, parseConds, parseAct, spansOf,
                         condText, condsText, actText, selText,
                         compileExpr, numError, numPreview, parseNum };
})(typeof window !== 'undefined' ? window : this);
