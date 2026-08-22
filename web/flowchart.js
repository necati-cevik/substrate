/* Flowchart editor for authoring character behaviour.
 *
 * A behaviour is a small directed graph — `{entry, nodes}` — of three node kinds:
 *
 *     decision   a list of AND'd conditions — `yes` / `no` edges
 *     action     a single action — one `next` edge
 *     behaviour  runs another saved chart, then carries on — one `next` edge
 *
 * `entry` names the node the walk begins at. Each tick the sim starts there and
 * follows edges, evaluating decisions and carrying out the actions it passes,
 * until the tick's action budget runs out or an edge leads nowhere. The budget
 * comes from the sim itself (`acts_per_tick`, one under decision 31), so a
 * second action on a path is work that never happens — the editor says which
 * actions are out of reach. A node is visited at most once per walk, so an edge
 * back to a node already passed ends the tick instead of looping; those edges
 * are marked too.
 *
 * Conditions and actions are written, not assembled from menus: a decision holds one
 * condition per line (`my hp < 10`), an action holds one line (`act on +hp source`), and
 * web/syntax.js parses them as they are typed — pointing at the word it choked on and
 * offering the words that would have been legal there. The vocabulary is the sim's own: the
 * grammar is fetched from `/api/grammar` when a server is there, and falls back to the copy
 * below for `file://` use, so the editor cannot write a node the sim would reject.
 *
 * Charts compose (decision 33): a `behaviour` node names another chart in the library, the
 * walk steps into it, and when the inner chart ends the walk carries on at that node's
 * `next`. Both charts share one tick, so the called chart's actions come out of the same
 * budget — which is why the editor analyses what it calls too, and says how many actions
 * the call can spend before it says whether anything after it can still run. A name that
 * is not in the library, and a chain of calls that would come back round to this chart,
 * are errors here for the same reason the sim refuses them.
 *
 * This file is the editor only: it turns a graph object into DOM + SVG and
 * back. Node positions and labels are editor state kept out of the graph — per
 * decision 29 a saved chart stays purely semantic — so they are remembered in
 * localStorage under the behaviour's name instead.
 *
 *   new Flowchart(container, { graph, onChange, library })
 *     .getGraph()    -> the graph object (deep copy)
 *     .setGraph(g)   -> replace and re-render
 *     .problems()    -> [{level, id, msg}] from the live analysis
 *     .destroy()     -> unbind window listeners
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------- grammar
  // The sim's vocabulary, restated for standalone use. `/api/grammar` overrides it.
  const FALLBACK = {
    stats: ['hp', 'speed', 'sense'],
    ops: ['<', '>', '<=', '>='],
    start: { hp: 20, speed: 2, sense: 6 },
    acts_per_tick: 1,          // sim/config.py: how many actions one walk may carry out
    cond: {
      always: [], self: ['stat', 'op', 'num'], other: ['stat', 'op', 'num'],
      dist_entity: ['op', 'num'], dist_source: ['stat', 'sign', 'op', 'num'],
      count_entity: ['op', 'num'], amount: ['stat', 'sign', 'op', 'num'],
    },
    act: { move: ['sel', 'sign'], act: ['sel', 'stat', 'sign'] },
    sel: { entity: [], source: ['stat', 'sign'], it: [], random: [] },
  };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  let G = clone(FALLBACK);

  // Which condition kinds resolve a subject that `it` can name, and which confirm a target
  // is actually in view (sim/sense.py: a condition about a target nobody perceives is
  // false, so an action on that target would be spent blind — decision 9).
  const SUBJECT_CONDS = new Set(['other', 'amount', 'dist_entity', 'dist_source']);
  const ENTITY_CONDS  = new Set(['other', 'dist_entity']);
  const SOURCE_CONDS  = new Set(['amount', 'dist_source']);

  const GLYPH = { decision: '◆', action: '□', behaviour: '⬡' };
  const TYPES = ['decision', 'action', 'behaviour'];
  const ENTRY = '▸';                  // the mark on the node a walk begins at
  const MARK = { error: '✕', warn: '⚠', info: '○' };
  const LIB_KEY = 'substrate.flowchart.library';
  const VIEW_KEY = 'substrate.flowchart.view';
  const SCRATCH = '*scratch*';        // the view slot for a chart with no name yet
  const MINUS = '−';

  // ---------------------------------------------------------------- utils
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const isTyping = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                               || t.tagName === 'SELECT' || t.isContentEditable);

  // What a freshly added node says, written the way the author will edit it: a test that
  // always holds, and the plainest useful act -- eating off the nearest food.
  const NEW_CONDS = () => ['always'];
  const NEW_ACT = () => 'act on +' + G.stats[0] + ' source';
  const NO_FACTS = () => ({ subject: false, entity: false, srcs: new Set() });

  const edgesOf = n => !n ? []
    : n.type === 'decision' ? [['yes', n.yes || ''], ['no', n.no || '']]
    : [['next', n.next || '']];

  // ---------------------------------------------------------------- the written grammar
  // web/syntax.js is the parser, the checker, and the inverse of both (a tuple -> the text
  // that would produce it). The threshold-expression whitelist (decision 28) lives there
  // too, so the browser holds one copy of it rather than one per surface.
  const S = global.ChartSyntax;
  if (!S) throw new Error('flowchart.js needs syntax.js loaded before it');
  const numError = S.numError;

  // ---------------------------------------------------------------- grammar validation
  // A mirror of sim/rules.py's `_field` / `_parse` / `_parse_act`, so the editor can say
  // what the sim would say without a round trip.
  function fieldError(t, v) {
    if (t === 'stat') return G.stats.indexOf(v) >= 0 ? null : 'not a stat: ' + v;
    if (t === 'op')   return G.ops.indexOf(v) >= 0 ? null : 'not an operator: ' + v;
    if (t === 'sign') return (v === 1 || v === -1) ? null : 'sign must be + or ' + MINUS;
    if (t === 'num')  return numError(v);
    if (t === 'sel')  return specError('sel', v, 'selector');
    return 'unknown field kind ' + t;
  }
  function specError(spec, v, what) {
    if (!Array.isArray(v) || !v.length) return what + ': expected [kind, ...]';
    const fields = G[spec] && G[spec][v[0]];
    if (!fields) return what + ': unknown kind ' + JSON.stringify(v[0]);
    if (v.length - 1 !== fields.length)
      return what + ' ' + v[0] + ': takes ' + fields.length + ' field(s), got ' + (v.length - 1);
    for (let i = 0; i < fields.length; i++) {
      const e = fieldError(fields[i], v[i + 1]);
      if (e) return what + ' ' + v[0] + ': ' + e;
    }
    return null;
  }
  function actError(a) {
    if (!Array.isArray(a) || !a.length) return 'action: expected [kind, ...]';
    if (a[0] === 'move') {
      if (a.length - 1 !== 2) return 'action move: takes a selector and a sign';
      return specError('sel', a[1], 'selector') || fieldError('sign', a[2]);
    }
    if (a[0] === 'act') {
      const se = specError('sel', a[1], 'selector');
      if (se) return se;
      if (a[1][0] === 'source') {
        return a.length - 1 === 1 ? null
          : 'an act on a source names no stat/sign (the source carries them)';
      }
      if (a.length - 1 !== 3) return 'action act: takes a selector, a stat and a sign';
      return fieldError('stat', a[2]) || fieldError('sign', a[3]);
    }
    return 'action: unknown kind ' + JSON.stringify(a[0]);
  }

  // ---------------------------------------------------------------- what a node holds
  // A node carries what was typed. Charts written before the text form -- and anything
  // pasted into the json tab -- carry tuples instead, so both are read everywhere, and a
  // tuple is shown as the text that would produce it.
  const isText = v => typeof v === 'string';
  const condsAsText = c => (isText(c) ? c
    : Array.isArray(c) ? c.map(x => (isText(x) ? x : S.condText(x))).join('\n') : '');
  const actAsText = a => (isText(a) ? a : a ? S.actText(a) : '');
  const typedIn = n => (n.type === 'decision'
    ? isText(n.conds) || (Array.isArray(n.conds) && n.conds.some(isText))
    : isText(n.act));

  // A node read as the sim will read it: {conds}|{act} when it parses, {err} -- carrying a
  // place in the text to point at -- when it does not. Tuples are passed through to
  // specError/actError instead, which judge the same grammar with no position to give.
  function valueOf(n) {
    if (!n || typeof n !== 'object') return {};
    if (n.type === 'decision') {
      const text = condsAsText(n.conds);
      if (!typedIn(n)) return { text, conds: Array.isArray(n.conds) ? n.conds : [] };
      const r = S.parse(text, 'conds');
      return r.error ? { text, err: r.error } : { text, conds: r.value };
    }
    if (n.type === 'action') {
      const text = actAsText(n.act);
      if (!typedIn(n)) return { text, act: n.act };
      const r = S.parse(text, 'act');
      return r.error ? { text, err: r.error } : { text, act: r.value };
    }
    return {};
  }

  // ---------------------------------------------------------------- text editors
  // One box per node: a decision's conditions one per line -- every one must hold, so the
  // lines read as an `and` -- and an action's single line.
  const textBoxHTML = (n, v) => (n.type === 'decision'
    ? `<textarea class="fc-text${v.err ? ' fc-bad' : ''}" data-kind="conds" spellcheck="false"`
      + ` rows="${Math.max(1, v.text.split('\n').length)}" placeholder="my hp < 10"`
      + ` title="one condition per line -- all of them must hold">${esc(v.text)}</textarea>`
    : `<input class="fc-text${v.err ? ' fc-bad' : ''}" data-kind="act" spellcheck="false"`
      + ` value="${esc(v.text)}" placeholder="move toward +hp source"`
      + ` title="one action -- the walk stops at the first one it reaches">`);

  // The checker's verdict: the line at fault with a caret under the word, what is wrong
  // with it, and the words that would have been legal there -- each a button, because
  // taking a suggestion should still be one click.
  function errHTML(text, e) {
    const nl = text.lastIndexOf('\n', Math.max(0, e.at - 1)) + 1;
    const cut = text.indexOf('\n', e.at);
    const line = text.slice(nl, cut < 0 ? text.length : cut);
    const col = Math.max(0, e.at - nl);
    const under = '^'.repeat(Math.max(1, Math.min(e.len, Math.max(1, line.length - col))));
    return `<div class="fc-err"><pre class="fc-caret">${esc(line)}\n${' '.repeat(col)}${under}</pre>`
      + `<div class="fc-errmsg">${esc(e.msg)}</div>`
      + ((e.expected || []).length
          ? `<div class="fc-fixes">${e.expected.map(w =>
              `<button class="fc-fix" data-ins="${esc(w)}" data-at="${e.at}" data-len="${e.len}"`
              + ` title="${esc('put `' + w + '` here')}">${esc(w)}</button>`).join('')}</div>`
          : '')
      + `</div>`;
  }

  // ---------------------------------------------------------------- analysis
  // Everything the editor knows about a chart without running it: what the sim would
  // reject, what can never run, and where the action budget runs out.
  // What a `behaviour` node's call is worth to the analysis: the chart it names, analysed
  // the same way, memoised by name, with the names already being analysed carried along so
  // a chain of calls that comes back round to one of them is reported instead of hung on.
  function subOf(name, ctx) {
    if (!name) return { err: 'names no behaviour to run' };
    if (!ctx || !ctx.lib) return { err: 'no library here to look "' + name + '" up in' };
    if (ctx.stack.indexOf(name) >= 0)
      return { err: 'this would end up running itself — ' + ctx.stack.concat(name).join(' → ') };
    if (!ctx.lib[name] || !ctx.lib[name].nodes)
      return { err: 'no saved behaviour named "' + name + '"' };
    if (ctx.cache[name]) return ctx.cache[name];
    const an = analyse(ctx.lib[name],
      { lib: ctx.lib, stack: ctx.stack.concat(name), cache: ctx.cache });
    const r = { an, exit: an.exit, size: Object.keys(ctx.lib[name].nodes).length,
                errors: an.problems.filter(p => p.level === 'error').length };
    ctx.cache[name] = r;
    return r;
  }

  function analyse(g, ctx) {
    ctx = ctx || { lib: null, stack: [], cache: {} };
    const nodes = (g && g.nodes) || {};
    const ids = Object.keys(nodes);
    const problems = [];
    // every behaviour node's call resolved once, before anything reasons about budgets
    const sub = {};
    for (const id of ids)
      if (nodes[id] && nodes[id].type === 'behaviour') sub[id] = subOf(nodes[id].name, ctx);
    // every node parsed once: the analysis below reasons about conditions and actions, and
    // whether they were typed or assembled is not its business
    const val = {};
    for (const id of ids) val[id] = valueOf(nodes[id]);
    const P = (level, id, msg) => problems.push({ level, id, msg });

    // one field, not a node: the chart says where its walk begins
    const entry = (g && typeof g.entry === 'string') ? g.entry : '';
    if (!entry) P('error', null, 'nothing says where the walk begins — mark a node ' + ENTRY);
    else if (!nodes[entry]) P('error', null, 'the walk begins at ' + entry + ', which is not a node');

    for (const id of ids) {
      const n = nodes[id];
      if (!n || typeof n !== 'object' || !n.type) { P('error', id, 'not a typed node'); continue; }
      if (TYPES.indexOf(n.type) < 0)
        P('error', id, 'unknown node type ' + JSON.stringify(n.type));
      for (const [e, t] of edgesOf(n))
        if (t && !nodes[t]) P('error', id, e + ' points at ' + t + ', which is not a node');
      if (n.type === 'decision') {
        if (val[id].err) P('error', id, val[id].err.msg);
        else if (!(val[id].conds || []).length) P('error', id, 'a decision needs at least one condition');
        else val[id].conds.forEach((c, i) => {
          const e = specError('cond', c, 'condition ' + (i + 1));
          if (e) P('error', id, e);
        });
        if (!n.yes && !n.no) P('warn', id, 'neither branch leads anywhere — the tick ends here either way');
        else if (n.yes && n.yes === n.no) P('warn', id, 'yes and no lead to the same node — the test changes nothing');
      } else if (n.type === 'action') {
        const e = val[id].err ? val[id].err.msg : actError(val[id].act);
        if (e) P('error', id, e);
      } else if (n.type === 'behaviour') {
        const s2 = sub[id] || {};
        if (s2.err) P('error', id, s2.err);
        else if (s2.errors) {
          const first = (s2.an.problems || []).find(p => p.level === 'error') || {};
          P('error', id, '"' + n.name + '" has ' + s2.errors + ' error'
            + (s2.errors > 1 ? 's' : '') + ' of its own, so the sim will not run it — '
            + (first.id ? first.id + ': ' : '') + (first.msg || ''));
        }
        // a call that can come back having spent nothing, with nothing wired after it, is a
        // branch that can pass the whole tick doing nothing -- which an action never can
        if (!n.next && s2.exit && s2.exit.min === 0)
          P('warn', id, '"' + (n.name || '?') + '" can come back having done nothing, and '
            + 'nothing follows it here — on those ticks the turn is spent doing nothing');
      }
    }

    // reachability, and the edges that close a cycle. The sim keeps a `seen` set, so an
    // edge back to a node already passed ends the walk instead of repeating it.
    const start = nodes[entry] ? entry : null;
    const reach = new Set();
    const back = new Set();
    if (start) {
      const state = {};
      const stack = [[start, 0]];
      state[start] = 1;
      reach.add(start);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const outs = edgesOf(nodes[top[0]]);
        if (top[1] >= outs.length) { state[top[0]] = 2; stack.pop(); continue; }
        const [e, t] = outs[top[1]++];
        if (!t || !nodes[t]) continue;
        if (state[t] === 1) back.add(top[0] + '|' + e);
        else if (!state[t]) { state[t] = 1; reach.add(t); stack.push([t, 0]); }
      }
    }
    for (const id of ids)
      if (!reach.has(id)) P('warn', id, 'nothing reaches it from ' + ENTRY + ' — it never runs');
    for (const key of back) {
      const [from, e] = key.split('|');
      P('warn', from, e + ' returns to ' + nodes[from][e] + ', already passed this tick; '
        + 'the sim visits each node once, so the walk stops there');
    }

    // the acyclic remainder, in topological order: budget arithmetic and the dataflow
    // that says whether a target has been confirmed in view before it is acted on.
    const dag = {}, preds = {}, indeg = {};
    for (const id of reach) { preds[id] = []; }
    for (const id of reach) {
      dag[id] = edgesOf(nodes[id]).filter(([e, t]) => t && nodes[t] && !back.has(id + '|' + e));
      for (const [e, t] of dag[id]) preds[t].push([id, e]);
    }
    for (const id of reach) indeg[id] = preds[id].length;
    const order = [];
    const queue = [...reach].filter(id => !indeg[id]);
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const [, t] of dag[id]) if (--indeg[t] === 0) queue.push(t);
    }

    const minA = {}, maxA = {}, minIn = {}, maxIn = {}, facts = {};
    const meet = (a, b) => ({
      subject: a.subject && b.subject,
      entity: a.entity && b.entity,
      srcs: new Set([...a.srcs].filter(s => b.srcs.has(s))),
    });
    const join = (a, b) => ({
      subject: a.subject || b.subject,
      entity: a.entity || b.entity,
      srcs: new Set([...a.srcs, ...b.srcs]),
    });
    // how many actions passing through a node costs: one for an action, and for a call,
    // whatever the chart it names spends on its own shortest and longest way out
    const cost = id => {
      const n = nodes[id];
      if (n.type === 'action') return [1, 1];
      if (n.type === 'behaviour' && sub[id] && sub[id].exit)
        return [sub[id].exit.min, sub[id].exit.max];
      return [0, 0];
    };
    const after = (p, e) => {
      const base = facts[p] || NO_FACTS();
      const n = nodes[p];
      // a call carries out of the sub-chart whatever every one of its ways out has proved
      if (n && n.type === 'behaviour')
        return sub[p] && sub[p].exit ? join(base, sub[p].exit.facts) : base;
      if (!n || n.type !== 'decision' || e !== 'yes') return base;   // a failed test binds nothing
      const r = { subject: base.subject, entity: base.entity, srcs: new Set(base.srcs) };
      for (const c of val[p].conds || []) {
        if (!Array.isArray(c)) continue;
        if (SUBJECT_CONDS.has(c[0])) r.subject = true;
        if (ENTITY_CONDS.has(c[0])) r.entity = true;
        if (SOURCE_CONDS.has(c[0])) r.srcs.add(c[1] + ':' + (c[2] > 0 ? 1 : -1));
        // "how many entities do I see" also proves one is there, when it proves anything
        if (c[0] === 'count_entity' && typeof c[2] === 'number'
            && ((c[1] === '>' && c[2] >= 0) || (c[1] === '>=' && c[2] >= 1))) r.entity = true;
      }
      return r;
    };
    for (const id of order) {
      const [incLo, incHi] = cost(id);
      let lo = Infinity, hi = 0, f = null;
      for (const [p, e] of preds[id]) {
        lo = Math.min(lo, minA[p]);
        hi = Math.max(hi, maxA[p]);
        const g2 = after(p, e);
        f = f ? meet(f, g2) : g2;
      }
      if (!preds[id].length) { lo = 0; hi = 0; }
      minIn[id] = lo; maxIn[id] = hi;              // spent before this node is reached
      minA[id] = lo + incLo;
      maxA[id] = hi + incHi;
      facts[id] = f || NO_FACTS();
    }

    // where a walk leaves this chart, and what it has spent and proved by then: an edge
    // that leads nowhere, and a back edge (the sim visits a node once, so a return to a
    // node already passed stops the walk there). This is the whole of what a
    // caller needs to know about a chart, and it is what `subOf` hands back up.
    let exFacts = null, exMin = Infinity, exMax = 0;
    const leaves = (id, f) => {
      exMin = Math.min(exMin, minA[id]);
      exMax = Math.max(exMax, maxA[id]);
      exFacts = exFacts ? meet(exFacts, f) : f;
    };
    for (const id of order) {
      const n = nodes[id];
      for (const [e, t] of edgesOf(n))
        if (!t || !nodes[t] || back.has(id + '|' + e)) leaves(id, after(id, e));
    }
    const exit = Number.isFinite(exMin)
      ? { min: exMin, max: exMax, facts: exFacts || NO_FACTS() }
      : { min: 0, max: 0, facts: NO_FACTS() };

    const budget = Math.max(1, Number(G.acts_per_tick) || 1);
    for (const id of order) {
      const n = nodes[id];
      if (n.type !== 'action' && n.type !== 'behaviour') continue;
      // the same arithmetic either way: what is already spent when the walk arrives, against
      // what a tick carries out. A call is only worth flagging if it would spend anything.
      const [, incHi] = cost(id);
      const what = n.type === 'action' ? 'action #' + minA[id] : '"' + n.name + '"';
      if (incHi > 0 && minIn[id] >= budget)
        P('warn', id, what + ' comes after ' + minIn[id] + ' action'
          + (minIn[id] > 1 ? 's' : '') + ' on the shortest path, and a tick carries out '
          + budget + ' — the walk stops before it, every tick');
      else if (incHi > 0 && maxIn[id] >= budget)
        P('info', id, what + ' comes after ' + maxIn[id] + ' action'
          + (maxIn[id] > 1 ? 's' : '') + ' on the longest path; only the first ' + budget
          + ' of a walk happen, so it runs on the short paths only');
      const act = val[id].act;
      if (n.type !== 'action' || !Array.isArray(act)) continue;
      const sl = act[1], f = facts[id];
      if (!Array.isArray(sl)) continue;
      if (sl[0] === 'it' && !f.subject)
        P('warn', id, '`it` is the subject of an earlier condition, and no branch reaching '
          + 'here has bound one — the action lands on nothing');
      if (sl[0] === 'entity' && !f.entity)
        P('info', id, 'nothing on the way here confirms an entity is in view; if none is, the action is spent blind');
      if (sl[0] === 'source' && !f.srcs.has(sl[1] + ':' + (sl[2] > 0 ? 1 : -1)))
        P('info', id, 'nothing on the way here confirms a ' + (sl[2] > 0 ? '+' : MINUS) + sl[1]
          + ' source is in view; if none is, the action is spent blind');
    }
    if (start && !order.some(id => nodes[id].type === 'action'
                                   || (nodes[id].type === 'behaviour' && cost(id)[1] > 0)))
      P('warn', null, 'no action is reachable — the chart decides but never does anything');

    const rank = { error: 0, warn: 1, info: 2 };
    problems.sort((a, b) => rank[a.level] - rank[b.level]);
    return { problems, reach, back, minA, maxA, minIn, maxIn, order, preds, dag,
             entry: start, val, sub, exit };
  }

  // ---------------------------------------------------------------- layout
  // Layer by longest path over the acyclic part, then order each layer by the barycentre
  // of its neighbours so edges cross as little as a sweep can manage. Height- and
  // width-aware, so nothing overlaps whatever the nodes measure.
  function layout(g, rect, an) {
    const nodes = g.nodes;
    const rc = id => rect[id] || { w: 250, h: 70 };
    const HGAP = 46, VGAP = 54, MARGIN = 40;
    const layer = {};
    for (const id of an.order) if (layer[id] === undefined) layer[id] = 0;
    for (const id of an.order)
      for (const [, t] of an.dag[id])
        layer[t] = Math.max(layer[t] === undefined ? 0 : layer[t], layer[id] + 1);

    const rows = [];
    for (const id of an.order) {
      const l = layer[id] || 0;
      (rows[l] || (rows[l] = [])).push(id);
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];

    // barycentre sweeps. `yes` is nudged left of `no` so a branch reads the way it is written.
    const idx = {};
    const reindex = () => rows.forEach(r => r.forEach((id, i) => { idx[id] = i; }));
    const kids = id => an.dag[id].map(([e, t], i) => [t, e === 'no' ? i + 0.5 : i]);
    reindex();
    for (let pass = 0; pass < 4; pass++) {
      const down = pass % 2 === 0;
      const seq = down ? rows.map((_, i) => i).slice(1)
                       : rows.map((_, i) => i).slice(0, -1).reverse();
      for (const l of seq) {
        const key = {};
        for (const id of rows[l]) {
          const near = down
            ? an.preds[id].map(([p, e]) => idx[p] + (e === 'no' ? 0.5 : e === 'yes' ? -0.5 : 0))
            : kids(id).map(([t, bias]) => idx[t] + bias * 0.01);
          key[id] = near.length ? near.reduce((a, b) => a + b, 0) / near.length : idx[id];
        }
        rows[l] = rows[l].slice().sort((a, b) => (key[a] - key[b]) || (idx[a] - idx[b]));
        reindex();
      }
    }

    const pos = {};
    let y = MARGIN;
    for (const row of rows) {
      const w = row.reduce((s, id) => s + rc(id).w, 0) + HGAP * Math.max(0, row.length - 1);
      let x = -w / 2;
      for (const id of row) { pos[id] = { x, y }; x += rc(id).w + HGAP; }
      y += (row.length ? Math.max(...row.map(id => rc(id).h)) : 0) + VGAP;
    }

    // whatever the entry cannot reach is parked in a column to the right of everything
    let right = 0;
    for (const id in pos) right = Math.max(right, pos[id].x + rc(id).w);
    let oy = MARGIN;
    for (const id of Object.keys(nodes)) {
      if (pos[id]) continue;
      pos[id] = { x: right + HGAP * 2, y: oy };
      oy += rc(id).h + VGAP;
    }

    let left = Infinity;
    for (const id in pos) left = Math.min(left, pos[id].x);
    if (Number.isFinite(left)) for (const id in pos) pos[id].x += MARGIN - left;
    return pos;
  }

  // ---------------------------------------------------------------- the blank chart
  // A graph in the shape the editor edits: an `entry` and a node table, both always there.
  // A chart written before the entry field -- one with `start` / `end` nodes -- is folded
  // into it on the way in, so an old file in the library or in localStorage still opens.
  function normGraph(g) {
    const nodes = clone((g && g.nodes) || {});
    let entry = (g && typeof g.entry === 'string') ? g.entry : '';
    const gone = new Set();
    for (const id of Object.keys(nodes)) {
      const t = nodes[id] && nodes[id].type;
      if (t !== 'start' && t !== 'end') continue;
      if (t === 'start' && !entry) entry = nodes[id].next || '';
      gone.add(id);
      delete nodes[id];
    }
    if (gone.size) {
      for (const n of Object.values(nodes))
        for (const e of ['next', 'yes', 'no'])
          if (gone.has(n[e])) n[e] = '';       // an edge into a folded-away node leads nowhere
      if (gone.has(entry)) entry = '';
    }
    return { entry, nodes };
  }
  const emptyGraph = () => normGraph(null);

  // ---------------------------------------------------------------- editor
  class Flowchart {
    constructor(el, opts) {
      opts = opts || {};
      this.el = el;
      this.g = normGraph(opts.graph);
      this.onChange = opts.onChange;
      this.pos = {};              // id -> {x,y} world-space top-left (editor state)
      this.labels = {};           // id -> author's note (editor state)
      this.rect = {};             // id -> measured {w,h}
      this.view = { x: 0, y: 0, k: 1 };
      this.sel = new Set();       // selected node ids
      this.selEdge = null;        // "id|edge"
      this.lit = null;            // node whose paths from the entry are highlighted
      this.name = '';             // the library name this chart came from
      this.dirty = false;
      this.tab = 'problems';
      this.lib = {};
      this.server = null;         // true/false once the backend has been probed
      this.clip = null;
      this.hints = true;
      this._seq = 1;
      this._hist = [];
      this._hi = -1;
      this._drag = null;
      this._space = false;
      this._raf = 0;

      this._shell();
      this._bind();
      this._loadViewFor(SCRATCH);
      this.render();
      this.fit();
      this._push();
      this._boot();
    }

    // ---- public ------------------------------------------------------
    getGraph() { return clone(this.g); }
    setGraph(g, name) {
      this.g = normGraph(g);
      this.pos = {};
      this.labels = {};
      this.sel.clear();
      this.selEdge = null;
      this.lit = null;
      this.name = name || '';
      this.dirty = false;
      this._loadViewFor(this.name || SCRATCH);
      this.render();
      this.fit();
      this._hist = [];
      this._hi = -1;
      this._push();
      this.emit();
    }
    problems() { return (this.an && this.an.problems.slice()) || []; }
    destroy() {
      for (const [t, f, o] of this._unbind) global.removeEventListener(t, f, o);
      this._unbind = [];
      this.el.innerHTML = '';
    }
    emit() { if (this.onChange) this.onChange(this.getGraph()); }

    // ---- shell -------------------------------------------------------
    _shell() {
      this.el.classList.add('fc');
      this.el.innerHTML = `
        <div class="fc-toolbar">
          <button data-act="add-decision" title="add a decision (1)">+ ${GLYPH.decision} decision</button>
          <button data-act="add-action" title="add an action (2)">+ ${GLYPH.action} action</button>
          <button data-act="add-behaviour" title="run another saved behaviour (3)">+ ${GLYPH.behaviour} behaviour</button>
          <span class="fc-sep"></span>
          <button data-act="undo" class="fc-icon" title="undo (ctrl+z)">↶</button>
          <button data-act="redo" class="fc-icon" title="redo (ctrl+shift+z)">↷</button>
          <span class="fc-sep"></span>
          <button data-act="tidy" title="re-layout the chart (l)">tidy</button>
          <button data-act="fit" title="fit to view (f)">fit</button>
          <button data-act="zoom-out" class="fc-icon" title="zoom out">−</button>
          <span class="fc-zoom fc-hint" title="zoom">100%</span>
          <button data-act="zoom-in" class="fc-icon" title="zoom in">+</button>
          <span class="fc-sep"></span>
          <button data-act="new" title="start from an empty chart">new</button>
          <button data-act="check" title="ask the sim to parse this chart">check</button>
          <span class="fc-spacer"></span>
          <button data-act="rail" class="fc-on" title="show or hide the side panel">panel</button>
        </div>
        <div class="fc-main">
          <div class="fc-canvas" tabindex="0">
            <div class="fc-world">
              <svg class="fc-edges"></svg>
              <div class="fc-nodes"></div>
            </div>
          </div>
          <div class="fc-rail">
            <div class="fc-tabs">
              <button data-tab="problems">checks</button>
              <button data-tab="library">library</button>
              <button data-tab="json">json</button>
              <button data-tab="syntax">writing</button>
              <button data-tab="help">keys</button>
            </div>
            <div class="fc-tabpane" data-pane="problems">
              <div class="fc-row">
                <button data-act="hints" class="fc-on" title="show or hide the quieter hints">hints</button>
                <span class="fc-hint fc-probsum"></span>
              </div>
              <div class="fc-problist"></div>
            </div>
            <div class="fc-tabpane" data-pane="library">
              <h3>save this chart</h3>
              <div class="fc-row">
                <input class="fc-lib-name" placeholder="behaviour name" title="a file name: letters, digits, - _ .">
                <button data-act="save">save</button>
              </div>
              <h3>saved behaviours</h3>
              <div class="fc-row">
                <input class="fc-lib-find" placeholder="filter">
              </div>
              <div class="fc-liblist"></div>
              <h3>files</h3>
              <div class="fc-row">
                <button data-act="export">export json</button>
                <button data-act="import">import json</button>
              </div>
              <div class="fc-hint fc-libwhere"></div>
            </div>
            <div class="fc-tabpane" data-pane="json">
              <div class="fc-row">
                <button data-act="json-copy">copy</button>
                <button data-act="json-apply">apply edits</button>
              </div>
              <textarea class="fc-json" spellcheck="false"></textarea>
            </div>
            <div class="fc-tabpane" data-pane="syntax">
              <h3>conditions — one per line, all must hold</h3>
              <div class="fc-syn">
                <div><code>always</code><span>no test at all</span></div>
                <div><code>my hp &lt; 10</code><span>your own stat against a threshold</span></div>
                <div><code>their speed &gt;= 3</code><span>the nearest entity close enough to read</span></div>
                <div><code>dist entity &lt;= 1</code><span>hexes to the nearest entity — 1 is reach</span></div>
                <div><code>dist +hp source &lt;= 1</code><span>hexes to the nearest source of that kind</span></div>
                <div><code>count entities &gt; 2</code><span>how many entities are in sight</span></div>
                <div><code>amount +hp source &gt; 0</code><span>how much is left in the nearest one</span></div>
              </div>
              <h3>actions — one, and the walk stops at it</h3>
              <div class="fc-syn">
                <div><code>move toward +hp source</code><span>a step closer</span></div>
                <div><code>move away from entity</code><span>a step further off</span></div>
                <div><code>move randomly</code><span>a step into one of the hexes next to you</span></div>
                <div><code>act on +hp source</code><span>draw from it; the source carries the stat</span></div>
                <div><code>act +hp on entity</code><span>give the nearest entity health</span></div>
                <div><code>act -hp on it</code><span>hit whatever the condition above matched</span></div>
              </div>
              <h3>behaviours — one chart running another</h3>
              <div class="fc-syn">
                <div><code>⬡ run eat</code><span>walks that chart here, then carries on at <code>then</code></span></div>
                <div><code>call</code><span>in the library: wires a node in that runs it — a live reference</span></div>
                <div><code>insert</code><span>pastes its nodes in instead — a copy, which then drifts</span></div>
              </div>
              <div class="fc-hint">A call is part of the same tick, so it spends from the same
                one-action budget: if the behaviour acts, nothing after it runs. Nothing may
                call its way back round to itself.</div>
              <h3>the pieces</h3>
              <div class="fc-syn">
                <div><code>hp speed sense</code><span>the stats</span></div>
                <div><code>&lt; &gt; &lt;= &gt;=</code><span>comparators; there is no equality on a float</span></div>
                <div><code>+hp source</code><span>a source is a stat and a direction</span></div>
                <div><code>entity · it</code><span>the nearest one · the subject of a condition above</span></div>
                <div><code>random</code><span>a hex next to you, drawn again every tick</span></div>
                <div><code>my.sense/2</code><span>a threshold may be arithmetic over your own stats</span></div>
                <div><code>my.max_hp</code><span>your ceiling — you are born full and cannot be filled past it, so <code>my hp &gt; my.max_hp/2</code> means half health</span></div>
              </div>
              <div class="fc-hint">Filler reads as you'd write it: <code>nearest</code>, <code>the</code>,
                <code>source</code> and parens are optional, and <code>gather +hp</code>,
                <code>move to</code>, <code>their</code>/<code>other</code> all land in the same place.</div>
            </div>
            <div class="fc-tabpane" data-pane="help">
              <div class="fc-keys">
                <div><kbd>drag port</kbd><span>wire an exit to a node, or drop on empty space to make one</span></div>
                <div><kbd>drag header</kbd><span>move a node (moves the whole selection)</span></div>
                <div><kbd>drag canvas</kbd><span>rubber-band select</span></div>
                <div><kbd>space / middle</kbd><span>pan</span></div>
                <div><kbd>wheel</kbd><span>zoom at the pointer</span></div>
                <div><kbd>click edge</kbd><span>select it · <kbd>del</kbd> unwires it</span></div>
                <div><kbd>shift+click</kbd><span>add to the selection</span></div>
                <div><kbd>1 2 3</kbd><span>add decision / action / behaviour</span></div>
                <div><kbd>e</kbd><span>begin the walk at the selected node</span></div>
                <div><kbd>del</kbd><span>delete the selection</span></div>
                <div><kbd>ctrl+z / +shift</kbd><span>undo / redo</span></div>
                <div><kbd>ctrl+c / ctrl+v</kbd><span>copy / paste nodes</span></div>
                <div><kbd>ctrl+d</kbd><span>duplicate the selection</span></div>
                <div><kbd>ctrl+a</kbd><span>select every node</span></div>
                <div><kbd>arrows</kbd><span>nudge (hold shift for 10×)</span></div>
                <div><kbd>l / f</kbd><span>tidy layout / fit to view</span></div>
                <div><kbd>esc</kbd><span>drop the selection, cancel a wire</span></div>
              </div>
            </div>
          </div>
        </div>
        <div class="fc-status">
          <span class="s-msg"></span>
          <span class="s-counts"></span>
        </div>`;

      this.canvas = this.el.querySelector('.fc-canvas');
      this.world = this.el.querySelector('.fc-world');
      this.nodesEl = this.el.querySelector('.fc-nodes');
      this.svg = this.el.querySelector('.fc-edges');
      this._showTab(this.tab);
    }

    _bind() {
      this._unbind = [];
      const on = (t, f, o) => { global.addEventListener(t, f, o); this._unbind.push([t, f, o]); };
      this.el.addEventListener('click', ev => this._onClick(ev));
      this.el.addEventListener('input', ev => this._onField(ev, false));
      this.el.addEventListener('change', ev => this._onField(ev, true));
      this.canvas.addEventListener('pointerdown', ev => this._onDown(ev));
      this.canvas.addEventListener('dblclick', ev => this._onDbl(ev));
      this.canvas.addEventListener('wheel', ev => this._onWheel(ev), { passive: false });
      on('keydown', ev => this._onKey(ev));
      on('keyup', ev => { if (ev.code === 'Space') this._setSpace(false); });
      on('blur', () => this._setSpace(false));
      on('resize', () => this._paint());
    }

    async _boot() {
      try {
        const r = await fetch('/api/grammar');
        if (!r.ok) throw new Error('http ' + r.status);
        const j = await r.json();
        if (j && j.cond && j.act && j.sel && j.stats && j.ops) {
          G = Object.assign(clone(FALLBACK), j);
          S.use(G);                       // the checker judges by the sim's stats and ops
          this.server = true;
          this.render();
        }
      } catch (ex) { /* file:// or no server: the built-in grammar stands */ }
      this._refreshLib();
    }

    // ---- geometry ----------------------------------------------------
    _rectOf(id) { return this.rect[id] || { w: 250, h: 70 }; }
    _toWorld(cx, cy) {
      const b = this.canvas.getBoundingClientRect();
      return { x: (cx - b.left - this.view.x) / this.view.k,
               y: (cy - b.top - this.view.y) / this.view.k };
    }
    _bounds() {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const id in this.pos) {
        const p = this.pos[id], q = this._rectOf(id);
        l = Math.min(l, p.x); t = Math.min(t, p.y);
        r = Math.max(r, p.x + q.w); b = Math.max(b, p.y + q.h);
      }
      if (!Number.isFinite(l)) return { l: 0, t: 0, r: 400, b: 300, w: 400, h: 300 };
      return { l, t, r, b, w: r - l, h: b - t };
    }
    _worldCentre() {
      const b = this.canvas.getBoundingClientRect();
      return this._toWorld(b.left + b.width / 2, b.top + b.height / 2);
    }
    _freeSpot(x, y, w, h) {
      const hits = () => Object.keys(this.pos).some(id => {
        const p = this.pos[id], q = this._rectOf(id);
        return x < p.x + q.w + 8 && x + w + 8 > p.x && y < p.y + q.h + 8 && y + h + 8 > p.y;
      });
      for (let i = 0; i < 60 && hits(); i++) y += 34;
      return { x: Math.round(x), y: Math.round(y) };
    }
    fit() {
      const b = this._bounds();
      const c = this.canvas.getBoundingClientRect();
      if (!c.width || !c.height) return;
      const k = clamp(Math.min((c.width - 48) / Math.max(1, b.w), (c.height - 48) / Math.max(1, b.h)), 0.25, 1.25);
      this.view.k = k;
      this.view.x = (c.width - b.w * k) / 2 - b.l * k;
      this.view.y = (c.height - b.h * k) / 2 - b.t * k;
      this._paint();
    }
    _zoomAt(k, cx, cy) {
      const b = this.canvas.getBoundingClientRect();
      const nk = clamp(k, 0.2, 2.5);
      const sx = cx - b.left, sy = cy - b.top;
      this.view.x = sx - (sx - this.view.x) * (nk / this.view.k);
      this.view.y = sy - (sy - this.view.y) * (nk / this.view.k);
      this.view.k = nk;
      this._paint();
    }
    _centreOn(id) {
      if (!this.pos[id]) return;
      const p = this.pos[id], q = this._rectOf(id);
      const c = this.canvas.getBoundingClientRect();
      this.view.x = c.width / 2 - (p.x + q.w / 2) * this.view.k;
      this.view.y = c.height / 2 - (p.y + q.h / 2) * this.view.k;
      this._paint();
    }

    _ports(id) {
      const n = this.g.nodes[id], p = this.pos[id];
      if (!n || !p) return {};
      const q = this._rectOf(id);
      if (n.type === 'decision')
        return { yes: { x: p.x + q.w * 0.28, y: p.y + q.h },
                 no:  { x: p.x + q.w * 0.72, y: p.y + q.h } };
      return { next: { x: p.x + q.w / 2, y: p.y + q.h } };
    }

    // ---- render ------------------------------------------------------
    // The library, and this chart's place in it, as the analysis wants them: a chart being
    // edited under a name cannot call anything that calls that name back.
    _ctx() { return { lib: this.lib || {}, stack: this.name ? [this.name] : [], cache: {} }; }

    render() {
      this.an = analyse(this.g, this._ctx());
      // A rebuild must not steal the keyboard. Remember where the caret was — which node,
      // and which field inside it — and put it back once the node DOM is rebuilt.
      const af = document.activeElement;
      let refocus = null;
      if (af && this.nodesEl.contains(af)) {
        const nel = af.closest('.fc-node');
        if (nel) refocus = { id: nel.dataset.id, i: [...nel.querySelectorAll('input, select, textarea')].indexOf(af) };
      }

      this.nodesEl.innerHTML = Object.keys(this.g.nodes)
        .map(id => this._nodeHTML(id, this.g.nodes[id])).join('');
      this.rect = {};
      for (const el of this.nodesEl.children)
        this.rect[el.dataset.id] = { w: el.offsetWidth, h: el.offsetHeight };

      const missing = Object.keys(this.g.nodes).filter(id => !this.pos[id]);
      if (missing.length === Object.keys(this.g.nodes).length) this.pos = layout(this.g, this.rect, this.an);
      else if (missing.length) {
        const l = layout(this.g, this.rect, this.an);
        const b = this._bounds();
        for (const id of missing)
          this.pos[id] = this._freeSpot(l[id].x, b.b + 40 + l[id].y, this._rectOf(id).w, this._rectOf(id).h);
      }

      this._paint();
      this._renderProblems();
      this._renderJSON();
      this._renderStatus();
      if (refocus && refocus.i >= 0) {
        const nel = this._nodeEl(refocus.id);
        const back = nel && [...nel.querySelectorAll('input, select, textarea')][refocus.i];
        if (back) back.focus();
      }
      this._saveViewSoon();
    }

    // Where in the tick a node falls: for an action, which action it is; for a call, the
    // action it would be spending first. `over` means the budget is gone before it.
    _badge(id) {
      const n = this.g.nodes[id], an = this.an;
      if (!n || (n.type !== 'action' && n.type !== 'behaviour')) return null;
      if (an.minA[id] === undefined) return null;
      const budget = Math.max(1, Number(G.acts_per_tick) || 1);
      if (n.type === 'action')
        return { text: '#' + an.minA[id], over: an.minA[id] > budget,
                 title: 'action #' + an.minA[id]
                   + (an.maxA[id] !== an.minA[id] ? ' on the shortest path, #' + an.maxA[id] + ' on the longest' : '')
                   + ' — an entity with speed ' + budget + ' does the first ' + budget };
      const spends = an.maxA[id] > an.maxIn[id];
      return { text: '#' + (an.minIn[id] + 1), over: spends && an.minIn[id] >= budget,
               title: 'reached with ' + an.minIn[id]
                 + (an.maxIn[id] !== an.minIn[id] ? '–' + an.maxIn[id] : '')
                 + " of the tick's " + budget + ' action(s) already spent' };
    }

    _nodeHTML(id, n) {
      const marks = (this.an.problems || []).filter(p => p.id === id);
      const worst = marks.length ? marks[0] : null;
      const b = this._badge(id);
      const badge = b
        ? `<span class="fc-badge${b.over ? ' over' : ''}" title="${esc(b.title)}">${esc(b.text)}</span>`
        : '';
      const mark = worst
        ? `<span class="fc-mark m-${worst.level}" title="${esc(marks.map(m => m.msg).join('\n'))}">${MARK[worst.level]}</span>`
        : '';
      const isEntry = this.g.entry === id;
      const head = `<div class="fc-head"><span class="fc-glyph">${GLYPH[n.type] || '?'}</span>`
        + `<input class="fc-label" value="${esc(this.labels[id] || '')}" placeholder="${esc(n.type)}"`
        + ` title="a note for you; the sim only reads the nodes">`
        + badge + mark
        + `<button class="fc-entry${isEntry ? ' on' : ''}" data-act="entry" title="${esc(isEntry
            ? 'the walk begins here every tick'
            : 'begin the walk here (e) — a chart has one entry, so this moves it')}">${ENTRY}</button>`
        + `<span class="fc-id">${esc(id)}</span>`
        + `<button class="fc-del" data-act="del" title="delete (del)">×</button>`
        + `</div>`;

      // The box holds the words the sim reads, so nothing restates it: under it sits only
      // the checker's complaint, in a slot that is there whether or not there is one to show.
      let body = '';
      if (n.type === 'behaviour') body = this._behBody(id, n);
      else if (n.type === 'decision' || n.type === 'action') {
        const v = ((this.an && this.an.val) || {})[id] || valueOf(n);
        const dec = n.type === 'decision';
        body = `<div class="fc-${dec ? 'cond' : 'act'}"><span class="fc-and">${dec ? 'if' : 'do'}</span>`
          + textBoxHTML(n, v) + `</div>`
          + `<div class="fc-slot">${v.err ? errHTML(v.text, v.err) : ''}</div>`;
      }
      const foot = n.type === 'decision'
        ? this._edgeSel('yes', n.yes) + this._edgeSel('no', n.no)
        : this._edgeSel('next', n.next);

      return `<div class="fc-node fc-${esc(n.type)}${isEntry ? ' fc-at-entry' : ''}`
        + `${this.sel.has(id) ? ' fc-selected' : ''}`
        + `${this.an.reach.has(id) ? '' : ' fc-unreached'}" data-id="${esc(id)}">${head}`
        + (body ? `<div class="fc-body">${body}</div>` : '')
        + (foot ? `<div class="fc-foot">${foot}</div>` : '')
        + this._portsHTML(n) + `</div>`;
    }
    // A call node holds one thing: which saved behaviour runs here. The names come from the
    // library, so — like the checker's fix buttons — you cannot name one that does not
    // exist; a name that has since gone stays listed and marked, because silently blanking
    // it would hide the break. Under it sits what the analysis found on the other side of
    // the call: how big it is, what it can spend, or why it will not run.
    _behBody(id, n) {
      const names = Object.keys(this.lib || {}).sort();
      const cur = n.name || '';
      const gone = cur && names.indexOf(cur) < 0;
      const opts = `<option value=""${cur ? '' : ' selected'}>(pick a behaviour)</option>`
        + names.map(nm => `<option value="${esc(nm)}"${nm === cur ? ' selected' : ''}>${esc(nm)}</option>`).join('')
        + (gone ? `<option value="${esc(cur)}" selected>${esc(cur)} — missing</option>` : '');
      const s = (this.an.sub || {})[id] || {};
      const acts = s.exit && (s.exit.min === s.exit.max
        ? s.exit.min + ' action' + (s.exit.min === 1 ? '' : 's')
        : s.exit.min + '–' + s.exit.max + ' actions');
      const note = s.err ? `<span class="fc-behbad">${esc(s.err)}</span>`
        : s.exit ? `<span class="fc-hint">${s.size} nodes · spends ${esc(acts)} of the tick</span>`
        : '';
      return `<div class="fc-beh"><span class="fc-and">run</span>`
        + `<select class="fc-behsel">${opts}</select>`
        + (cur && !gone ? `<button class="fc-mini" data-act="open-beh" title="${esc('open "'
            + cur + '" in the editor')}">open</button>` : '')
        + `</div><div class="fc-slot">${note}</div>`;
    }

    _portsHTML(n) {
      const one = (edge, cls, left) =>
        `<span class="fc-port ${cls}${n[edge] ? '' : ' p-open'}" data-port="${edge}"`
        + ` style="left:${left}" title="${esc('drag to wire ' + edge
            + (n[edge] ? ' (currently ' + n[edge] + ')' : ' — nothing wired yet'))}"></span>`;
      if (n.type === 'decision') return one('yes', 'p-yes', '28%') + one('no', 'p-no', '72%');
      return one('next', 'p-next', '50%');
    }
    _edgeSel(edge, val) {
      const opts = '<option value="">(none)</option>' + Object.keys(this.g.nodes).map(id =>
        `<option value="${esc(id)}"${id === val ? ' selected' : ''}>${GLYPH[this.g.nodes[id].type] || '?'} ${esc(id)}${
          this.labels[id] ? ' ' + esc(this.labels[id].slice(0, 14)) : ''}</option>`).join('');
      return `<label>${edge === 'next' ? 'then' : edge}`
        + `<select class="fc-edge-sel" data-edge="${edge}">${opts}</select></label>`;
    }

    // Repaint everything geometric: the world transform, the edges, and the per-node
    // marks that depend on the analysis. Node bodies are left alone, so an open dropdown
    // or a half-typed threshold survives.
    _paint() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._paintNow(); });
    }
    _paintNow() {
      const v = this.view;
      this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
      const z = this.el.querySelector('.fc-zoom');
      if (z) z.textContent = Math.round(v.k * 100) + '%';

      const b = this._bounds();
      const W = Math.ceil(b.r + 200), H = Math.ceil(b.b + 200);
      this.svg.setAttribute('width', W);
      this.svg.setAttribute('height', H);
      this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

      for (const el of this.nodesEl.children) {
        const p = this.pos[el.dataset.id];
        if (!p) continue;
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.classList.toggle('fc-selected', this.sel.has(el.dataset.id));
      }

      const path = this.lit ? this._pathsTo(this.lit) : null;
      let out = '';
      for (const [c, id] of [['#4a5563', 'd'], ['#3f7a55', 'y'], ['#8a5236', 'n'], ['#67e8f9', 's']])
        out += `<marker id="fc-a-${id}" markerWidth="9" markerHeight="9" refX="7.5" refY="3"`
          + ` orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7.5,3 L0,6 z" fill="${c}"/></marker>`;
      out = `<defs>${out}</defs>`;

      for (const id in this.g.nodes) {
        const n = this.g.nodes[id];
        const ports = this._ports(id);
        for (const [edge, t] of edgesOf(n)) {
          if (!t || !this.pos[t] || !ports[edge]) continue;
          const key = id + '|' + edge;
          const isBack = this.an.back.has(key);
          const cls = ['fc-edge', edge === 'yes' ? 'e-yes' : edge === 'no' ? 'e-no' : 'e-plain'];
          let mk = edge === 'yes' ? 'y' : edge === 'no' ? 'n' : 'd';
          if (isBack) cls.push('e-back');
          if (this.selEdge === key) { cls.push('e-sel'); mk = 's'; }
          else if (path) cls.push(path.edges.has(key) ? 'e-lit' : 'e-dim');
          const d = this._edgePath(ports[edge], t, id);
          out += `<path d="${d}" class="fc-hit" data-edge-key="${esc(key)}"/>`
            + `<path d="${d}" class="${cls.join(' ')}" marker-end="url(#fc-a-${mk})"/>`;
          if (edge !== 'next') {
            const lx = ports[edge].x + (edge === 'yes' ? -6 : 6);
            out += `<text x="${lx}" y="${ports[edge].y + 15}" class="fc-elabel l-${edge}"`
              + ` text-anchor="${edge === 'yes' ? 'end' : 'start'}">${edge}${isBack ? ' ↺' : ''}</text>`;
          } else if (isBack) {
            out += `<text x="${ports[edge].x + 6}" y="${ports[edge].y + 15}" class="fc-elabel">↺</text>`;
          }
        }
      }
      this.svg.innerHTML = out + (this._linkPath || '');

      for (const el of this.nodesEl.children) {
        const id = el.dataset.id;
        el.classList.toggle('fc-unreached', !this.an.reach.has(id));
        el.classList.toggle('fc-dim', !!path && !path.nodes.has(id));
      }
    }

    // A cubic down the page when the target is below; a bow out to the side when the edge
    // has to climb, which is exactly where the sim stops the walk.
    _edgePath(s, tid, sid) {
      const p = this.pos[tid], q = this._rectOf(tid);
      const enterTop = { x: p.x + q.w / 2, y: p.y };
      if (tid !== sid && enterTop.y > s.y + 24) {
        const d = clamp(Math.abs(enterTop.y - s.y) / 2, 26, 110);
        return `M ${s.x} ${s.y} C ${s.x} ${s.y + d}, ${enterTop.x} ${enterTop.y - d}, ${enterTop.x} ${enterTop.y}`;
      }
      const right = s.x >= p.x + q.w / 2;
      const a = { x: right ? p.x + q.w : p.x, y: p.y + q.h / 2 };
      const bow = 78, dir = right ? 1 : -1;
      return `M ${s.x} ${s.y} C ${s.x} ${s.y + bow}, ${a.x + dir * bow} ${a.y + bow}, ${a.x} ${a.y}`;
    }

    // Everything on some entry -> id walk: reachable from the entry, and able to reach id.
    // Two cheap sweeps rather than an enumeration of paths.
    _pathsTo(id) {
      const nodes = new Set(), edges = new Set();
      if (!this.g.nodes[id]) return { nodes, edges };
      const canReach = new Set([id]);
      for (let changed = true; changed;) {
        changed = false;
        for (const k in this.g.nodes)
          if (!canReach.has(k) && edgesOf(this.g.nodes[k]).some(([, t]) => canReach.has(t))) {
            canReach.add(k);
            changed = true;
          }
      }
      for (const k of this.an.reach) if (canReach.has(k)) nodes.add(k);
      for (const k of nodes)
        for (const [e, t] of edgesOf(this.g.nodes[k]))
          if (nodes.has(t)) edges.add(k + '|' + e);
      return { nodes, edges };
    }

    // ---- rail --------------------------------------------------------
    _showTab(t) {
      this.tab = t;
      for (const b of this.el.querySelectorAll('.fc-tabs button'))
        b.classList.toggle('fc-on', b.dataset.tab === t);
      for (const p of this.el.querySelectorAll('.fc-tabpane'))
        p.classList.toggle('fc-shown', p.dataset.pane === t);
      if (t === 'json') this._renderJSON();
    }
    _renderProblems() {
      const list = this.el.querySelector('.fc-problist');
      const all = this.an.problems;
      const shown = this.hints ? all : all.filter(p => p.level !== 'info');
      const n = l => all.filter(p => p.level === l).length;
      this.el.querySelector('.fc-probsum').textContent =
        `${n('error')} error · ${n('warn')} warning · ${n('info')} hint`;
      list.innerHTML = shown.length
        ? shown.map(p => `<div class="fc-prob p-${p.level}" data-prob="${esc(p.id || '')}">`
            + `<span class="pl">${MARK[p.level]}</span>`
            + `<span class="pn">${esc(p.id || '·')}</span>`
            + `<span class="pm">${esc(p.msg)}</span></div>`).join('')
        : `<div class="fc-ok">✓ nothing to flag</div>`;
    }
    _renderJSON() {
      if (this.tab !== 'json') return;
      const ta = this.el.querySelector('.fc-json');
      if (ta && document.activeElement !== ta) ta.value = JSON.stringify(this.g, null, 2);
    }
    _renderStatus(msg, cls) {
      const m = this.el.querySelector('.s-msg');
      if (msg !== undefined) {
        m.textContent = msg;
        m.className = 's-msg' + (cls ? ' s-' + cls : '');
        clearTimeout(this._msgT);
        this._msgT = setTimeout(() => { if (m.textContent === msg) this._renderStatus(''); }, 6000);
      } else if (!m.textContent) {
        m.className = 's-msg';
        m.textContent = this.name
          ? (this.dirty ? '● ' : '') + this.name + (this.dirty ? ' (unsaved changes)' : ' (saved)')
          : 'unnamed chart';
      }
      const ids = Object.keys(this.g.nodes);
      const acts = ids.filter(i => this.g.nodes[i].type === 'action').length;
      const calls = ids.filter(i => this.g.nodes[i].type === 'behaviour').length;
      const errs = this.an.problems.filter(p => p.level === 'error').length;
      this.el.querySelector('.s-counts').innerHTML =
        `<b>${ids.length}</b> nodes · <b>${acts}</b> actions · `
        + (calls ? `<b>${calls}</b> call${calls > 1 ? 's' : ''} · ` : '')
        + (errs ? `<b style="color:var(--err)">${errs}</b> errors` : 'no errors')
        + (this.sel.size ? ` · <b>${this.sel.size}</b> selected` : '');
      const u = this.el.querySelector('[data-act="undo"]'), r = this.el.querySelector('[data-act="redo"]');
      if (u) u.disabled = this._hi <= 0;
      if (r) r.disabled = this._hi >= this._hist.length - 1;
    }
    _flash(id) {
      const el = this._nodeEl(id);
      if (!el) return;
      this._centreOn(id);
      el.classList.remove('fc-flash');
      void el.offsetWidth;
      el.classList.add('fc-flash');
    }
    _nodeEl(id) { return this.nodesEl.querySelector(`[data-id="${CSS.escape(id)}"]`); }

    // ---- history -----------------------------------------------------
    _push() {
      this._hist.length = this._hi + 1;
      this._hist.push({ g: clone(this.g), pos: clone(this.pos), labels: clone(this.labels) });
      if (this._hist.length > 80) this._hist.shift();
      this._hi = this._hist.length - 1;
      this._renderStatus();
    }
    _commit() {
      this.dirty = true;
      this._push();
      this.emit();
      this._saveViewSoon();
    }
    _restore(i) {
      if (i < 0 || i >= this._hist.length) return;
      this._hi = i;
      const s = this._hist[i];
      this.g = clone(s.g);
      this.pos = clone(s.pos);
      this.labels = clone(s.labels);
      for (const id of [...this.sel]) if (!this.g.nodes[id]) this.sel.delete(id);
      this.dirty = true;
      this.render();
      this.emit();
    }

    // ---- editing -----------------------------------------------------
    _newId() {
      while (this.g.nodes['n' + this._seq]) this._seq++;
      return 'n' + this._seq++;
    }
    _newNode(type, at) {
      const id = this._newId();
      const n = { type };
      if (type === 'decision') Object.assign(n, { conds: NEW_CONDS(), yes: '', no: '' });
      if (type === 'action') Object.assign(n, { act: NEW_ACT(), next: '' });
      if (type === 'behaviour')
        Object.assign(n, { name: Object.keys(this.lib || {}).sort()[0] || '', next: '' });
      this.g.nodes[id] = n;
      if (!this.g.nodes[this.g.entry]) this.g.entry = id;   // the first node is the entry
      const c = at || this._worldCentre();
      this.pos[id] = this._freeSpot(c.x - 120, c.y - 30, 240, 70);
      return id;
    }
    _addNode(type, at) {
      const id = this._newNode(type, at);
      this.sel = new Set([id]);
      this.selEdge = null;
      this.render();
      this._commit();
      const el = this._nodeEl(id);
      if (el) {
        const b = el.getBoundingClientRect(), c = this.canvas.getBoundingClientRect();
        if (b.top < c.top || b.bottom > c.bottom || b.left < c.left || b.right > c.right) this._centreOn(id);
      }
      return id;
    }
    _delNodes(ids) {
      ids = ids.filter(id => this.g.nodes[id]);
      if (!ids.length) return;
      for (const id of ids) { delete this.g.nodes[id]; delete this.pos[id]; delete this.labels[id]; this.sel.delete(id); }
      if (ids.indexOf(this.g.entry) >= 0) this.g.entry = '';
      for (const k in this.g.nodes) {
        const n = this.g.nodes[k];
        if (n.type === 'decision') {
          if (ids.indexOf(n.yes) >= 0) n.yes = '';
          if (ids.indexOf(n.no) >= 0) n.no = '';
        } else if (ids.indexOf(n.next) >= 0) n.next = '';
      }
      this.selEdge = null;
      this.render();
      this._commit();
      this._renderStatus(`deleted ${ids.length} node${ids.length > 1 ? 's' : ''}`);
    }
    // Which node the walk begins at. A chart has one, so this moves the mark rather than
    // adding one -- and the sim reads it off the chart, not off any node.
    _setEntry(id) {
      if (!this.g.nodes[id] || this.g.entry === id) return;
      this.g.entry = id;
      this.render();
      this._commit();
      this._renderStatus(`the walk begins at ${id}`, 'ok');
    }
    _setEdge(id, edge, target) {
      const n = this.g.nodes[id];
      if (!n) return;
      n[edge] = target || '';
      this.render();
      this._commit();
    }
    // What was typed goes into the node as typed, parsed or not: a half-written condition
    // is a state to show and fix, not something to drop or quietly revert. A decision's box
    // is split the way the sim splits it -- a line, or an `and`, per condition.
    _readNode(id) {
      const n = this.g.nodes[id], box = this._nodeEl(id);
      if (!n || !box) return;
      const t = box.querySelector('.fc-text');
      if (!t) return;
      if (n.type === 'decision')
        n.conds = S.spansOf(t.value).map(([a, b]) => t.value.slice(a, b).trim());
      else if (n.type === 'action') n.act = t.value.trim();
      const v = valueOf(n);
      t.classList.toggle('fc-bad', !!v.err);
      const slot = box.querySelector('.fc-slot');
      if (slot) slot.innerHTML = v.err ? errHTML(v.text, v.err) : '';
    }
    // Re-run the analysis and refresh only what it drives: edges, marks, badges, the
    // checks list and the status bar. Never touches a node's fields.
    _reflow() {
      this.an = analyse(this.g, this._ctx());
      for (const el of this.nodesEl.children) {
        const id = el.dataset.id;
        const marks = this.an.problems.filter(p => p.id === id);
        const mk = el.querySelector('.fc-mark'), head = el.querySelector('.fc-head');
        const worst = marks[0];
        if (worst && mk) {
          mk.className = 'fc-mark m-' + worst.level;
          mk.textContent = MARK[worst.level];
          mk.title = marks.map(m => m.msg).join('\n');
        } else if (worst && head) {
          const s = document.createElement('span');
          s.className = 'fc-mark m-' + worst.level;
          s.textContent = MARK[worst.level];
          s.title = marks.map(m => m.msg).join('\n');
          head.insertBefore(s, head.querySelector('.fc-id'));
        } else if (mk) mk.remove();
        const badge = el.querySelector('.fc-badge');
        const b = this._badge(id);
        if (badge && b) {
          badge.textContent = b.text;
          badge.title = b.title;
          badge.classList.toggle('over', b.over);
        }
        for (const p of el.querySelectorAll('.fc-port'))
          p.classList.toggle('p-open', !this.g.nodes[id][p.dataset.port]);
      }
      this._paint();
      this._renderProblems();
      this._renderJSON();
      this._renderStatus();
    }

    _remap(ids, dx, dy) {
      // copy a set of nodes, keeping the edges that stay inside the set
      const map = {};
      for (const id of ids) map[id] = this._newId();
      const made = [];
      for (const id of ids) {
        const src = this.g.nodes[id];
        const n = clone(src);
        if (n.type === 'decision') { n.yes = map[n.yes] || ''; n.no = map[n.no] || ''; }
        else n.next = map[n.next] || '';
        this.g.nodes[map[id]] = n;
        if (this.labels[id]) this.labels[map[id]] = this.labels[id];
        const p = this.pos[id] || { x: 60, y: 60 };
        this.pos[map[id]] = { x: p.x + dx, y: p.y + dy };
        made.push(map[id]);
      }
      return made;
    }
    _duplicate() {
      const ids = [...this.sel].filter(id => this.g.nodes[id]);
      if (!ids.length) return;
      const made = this._remap(ids, 28, 28);
      this.sel = new Set(made);
      this.render();
      this._commit();
      this._renderStatus(`duplicated ${made.length} node${made.length > 1 ? 's' : ''}`);
    }
    _copy() {
      const ids = [...this.sel].filter(id => this.g.nodes[id]);
      if (!ids.length) return;
      this.clip = { nodes: {}, pos: {}, labels: {} };
      for (const id of ids) {
        this.clip.nodes[id] = clone(this.g.nodes[id]);
        this.clip.pos[id] = clone(this.pos[id] || { x: 0, y: 0 });
        if (this.labels[id]) this.clip.labels[id] = this.labels[id];
      }
      this._renderStatus(`copied ${ids.length} node${ids.length > 1 ? 's' : ''}`);
    }
    _paste() {
      if (!this.clip) return;
      const ids = Object.keys(this.clip.nodes);
      const map = {};
      for (const id of ids) map[id] = this._newId();
      let minX = Infinity, minY = Infinity;
      for (const id of ids) { minX = Math.min(minX, this.clip.pos[id].x); minY = Math.min(minY, this.clip.pos[id].y); }
      const c = this._worldCentre();
      const made = [];
      for (const id of ids) {
        const n = clone(this.clip.nodes[id]);
        if (n.type === 'decision') { n.yes = map[n.yes] || ''; n.no = map[n.no] || ''; }
        else n.next = map[n.next] || '';
        this.g.nodes[map[id]] = n;
        if (this.clip.labels[id]) this.labels[map[id]] = this.clip.labels[id];
        this.pos[map[id]] = { x: c.x + this.clip.pos[id].x - minX - 100,
                              y: c.y + this.clip.pos[id].y - minY - 40 };
        made.push(map[id]);
      }
      this.sel = new Set(made);
      this.render();
      this._commit();
      this._renderStatus(`pasted ${made.length} node${made.length > 1 ? 's' : ''}`);
    }
    _tidy() {
      this.pos = layout(this.g, this.rect, this.an);
      this._paint();
      this._commit();
      this.fit();
    }
    _clearAll() {
      this.g = emptyGraph();
      this.pos = {};
      this.labels = {};
      this._seq = 1;
      this.sel.clear();
      this.selEdge = null;
      this.name = '';
      this.dirty = false;
      this.render();
      this.fit();
      this._commit();
    }

    // ---- library -----------------------------------------------------
    _local() {
      try {
        const raw = global.localStorage && global.localStorage.getItem(LIB_KEY);
        return raw ? (JSON.parse(raw) || {}) : {};
      } catch (ex) { return this._memLib || (this._memLib = {}); }
    }
    _saveLocal(lib) {
      try { global.localStorage.setItem(LIB_KEY, JSON.stringify(lib)); }
      catch (ex) { this._memLib = lib; }
    }
    async _refreshLib() {
      try {
        const r = await fetch('/api/behaviours');
        if (!r.ok) throw new Error('http ' + r.status);
        this.lib = (await r.json()).behaviours || {};
        this.server = true;
      } catch (ex) {
        this.server = false;
        this.lib = this._local();
      }
      this.render();          // behaviour nodes resolve against the library, so re-analyse
      this._renderLib();
    }

    // who calls whom, straight off the saved graphs
    _callsOf(g) {
      return [...new Set(Object.values((g || {}).nodes || {})
        .filter(n => n && n.type === 'behaviour' && n.name).map(n => n.name))];
    }
    _callersOf(name) {
      return Object.keys(this.lib).filter(k => this._callsOf(this.lib[k]).indexOf(name) >= 0).sort();
    }
    _renderLib() {
      const where = this.el.querySelector('.fc-libwhere');
      if (where) where.textContent = this.server
        ? 'saved as behaviours/<name>.json next to serve.py'
        : 'no server: saved in this browser’s localStorage';
      const box = this.el.querySelector('.fc-liblist');
      const find = (this.el.querySelector('.fc-lib-find') || {}).value || '';
      const names = Object.keys(this.lib).filter(n => n.toLowerCase().indexOf(find.toLowerCase()) >= 0).sort();
      // what this chart already calls, so the library reads as a set of parts and shows
      // which of them are wired in here
      const called = new Set(this._callsOf(this.g));
      box.innerHTML = names.length ? names.map(n => {
        const size = Object.keys((this.lib[n] || {}).nodes || {}).length;
        const by = this._callersOf(n).filter(k => k !== n);
        const tip = 'load ' + n + ' — ' + size + ' nodes'
          + (by.length ? '\ncalled by ' + by.join(', ') : '');
        return `<div class="fc-libitem${n === this.name ? ' fc-cur' : ''}">`
          + `<span class="ln" data-load="${esc(n)}" title="${esc(tip)}">${esc(n)}`
          + ` <span class="fc-hint">${size}</span></span>`
          + (called.has(n) ? `<span class="fc-called" title="${esc('this chart runs ' + n)}">${GLYPH.behaviour}</span>` : '')
          + `<button data-call="${esc(n)}" title="${esc('add a node here that runs ' + n
              + ' — a live reference, so editing ' + n + ' changes this chart too')}">call</button>`
          + `<button data-insert="${esc(n)}" title="paste this behaviour's nodes in at the selected action or call — a copy, not a reference">insert</button>`
          + `<button data-delete="${esc(n)}" class="fc-danger" title="delete">×</button></div>`;
      }).join('') : `<div class="fc-empty">${Object.keys(this.lib).length ? 'nothing matches' : 'nothing saved yet'}</div>`;
    }
    async _save() {
      const inp = this.el.querySelector('.fc-lib-name');
      const name = (inp.value || this.name).trim();
      if (!name) { this._renderStatus('name the behaviour first', 'err'); inp.focus(); return; }
      const safe = name.replace(/[^A-Za-z0-9._-]/g, '');
      if (!safe) { this._renderStatus('a name needs letters, digits, - _ or .', 'err'); return; }
      if (safe !== name) this._renderStatus(`saved as "${safe}"`, 'ok');
      if (this.lib[safe] && safe !== this.name
          && !global.confirm(`"${safe}" already exists. Overwrite it?`)) return;
      const graph = this.getGraph();
      if (this.server) {
        try {
          const r = await fetch('/api/behaviours', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: safe, graph }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { this._renderStatus('save refused: ' + (j.error || r.status), 'err'); return; }
          this.lib = j.behaviours || this.lib;
        } catch (ex) { this._renderStatus('save failed: ' + ex.message, 'err'); return; }
      } else {
        this.lib[safe] = graph;
        this._saveLocal(this.lib);
      }
      this.name = safe;
      this.dirty = false;
      inp.value = safe;
      this._saveView();
      this._renderLib();
      this._renderStatus(`saved ${safe}`, 'ok');
    }
    async _load(name) {
      await this._refreshLib();
      const g = this.lib[name];
      if (!g) { this._renderStatus(`no behaviour "${name}"`, 'err'); return; }
      if (this.dirty && !global.confirm('Discard the unsaved changes to this chart?')) return;
      this.el.querySelector('.fc-lib-name').value = name;
      this.setGraph(clone(g), name);
      this._renderLib();
      this._renderStatus(`loaded ${name}`, 'ok');
    }
    async _delete(name) {
      const by = this._callersOf(name).filter(k => k !== name);
      if (!global.confirm(`Delete the behaviour "${name}"?`
          + (by.length ? `\n\n${by.join(', ')} run${by.length > 1 ? '' : 's'} it, and `
             + `${by.length > 1 ? 'those charts' : 'that chart'} will not parse without it.` : '')))
        return;
      if (this.server) {
        try {
          const r = await fetch('/api/behaviours?name=' + encodeURIComponent(name), { method: 'DELETE' });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { this._renderStatus('delete refused: ' + (j.error || r.status), 'err'); return; }
          this.lib = j.behaviours || {};
        } catch (ex) { this._renderStatus('delete failed: ' + ex.message, 'err'); return; }
      } else {
        delete this.lib[name];
        this._saveLocal(this.lib);
      }
      if (this.name === name) this.name = '';
      this._renderLib();
      this._renderStatus(`deleted ${name}`, 'ok');
    }

    // Wire a saved behaviour in as a call: a node that runs it and comes back. Unlike
    // `insert` below this is a reference, not a copy -- editing the named chart changes
    // every chart that calls it. Dropped in at the selection when that leaves somewhere
    // sensible to put it, so one click both makes the node and wires it up.
    async _call(name) {
      await this._refreshLib();
      if (!this.lib[name]) { this._renderStatus(`no behaviour "${name}"`, 'err'); return; }
      const from = [...this.sel][0];
      const fn = this.sel.size === 1 && from && this.g.nodes[from];
      const edge = !fn ? null
        : fn.type === 'decision' ? (!fn.yes ? 'yes' : !fn.no ? 'no' : null)
        : !fn.next ? 'next' : null;
      const at = fn && this.pos[from]
        ? { x: this.pos[from].x + this._rectOf(from).w / 2, y: this.pos[from].y + this._rectOf(from).h + 110 }
        : null;
      const id = this._newNode('behaviour', at);
      this.g.nodes[id].name = name;
      if (edge) this.g.nodes[from][edge] = id;
      this.sel = new Set([id]);
      this.selEdge = null;
      this.render();
      this._commit();
      this._centreOn(id);
      this._renderStatus(edge ? `${from} ${edge} → runs ${name}`
        : `added a node that runs ${name} — wire it up`, 'ok');
    }

    // Inline a saved behaviour in place of one action or call: whatever led to the replaced
    // node now leads to the inlined chart's entry, and every branch of it that leads nowhere
    // picks up wherever that node used to lead, so the host chart keeps flowing.
    async _insert(name) {
      await this._refreshLib();
      const src0 = this.lib[name];
      if (!src0) { this._renderStatus(`no behaviour "${name}"`, 'err'); return; }
      const target = [...this.sel][0];
      const tn = target && this.g.nodes[target];
      if (!tn || this.sel.size !== 1) {
        this._renderStatus('select one action or behaviour to replace, then insert', 'err');
        return;
      }
      if (tn.type === 'decision') {
        this._renderStatus('pick an action or a behaviour to replace', 'err');
        return;
      }
      const src = clone(src0.nodes || {});
      const outTarget = tn.next || '';

      const newIds = {};
      for (const sid of Object.keys(src)) newIds[sid] = this._newId();
      // a branch of the inlined chart that led nowhere is a return, so it becomes a jump to
      // whatever followed the node being replaced -- nowhere too, if nothing did
      const mapEdge = ref => (ref && newIds[ref]) || outTarget;
      const entry = mapEdge(src0.entry);

      const remapped = {};
      for (const sid of Object.keys(src)) {
        const nn = clone(src[sid]);
        if (nn.type === 'decision') { nn.yes = mapEdge(nn.yes); nn.no = mapEdge(nn.no); }
        else nn.next = mapEdge(nn.next);
        remapped[newIds[sid]] = nn;
      }
      for (const k in this.g.nodes) {
        const n = this.g.nodes[k];
        if (k === target) continue;
        if (n.type === 'decision') {
          if (n.yes === target) n.yes = entry;
          if (n.no === target) n.no = entry;
        } else if (n.next === target) n.next = entry;
      }
      if (this.g.entry === target) this.g.entry = entry;   // it was the top of the chart
      Object.assign(this.g.nodes, remapped);
      delete this.g.nodes[target];
      delete this.pos[target];
      delete this.labels[target];
      this.sel = new Set(Object.keys(remapped));
      this.an = analyse(this.g, this._ctx());
      this.render();
      this._tidy();
      this._renderStatus(`inlined ${name} — ${Object.keys(remapped).length} nodes, re-laid out`, 'ok');
    }

    // ---- the sim's own verdict ---------------------------------------
    async _check() {
      try {
        const r = await fetch('/api/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chart: this.getGraph() }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) this._renderStatus(`the sim accepts this chart (${j.nodes} nodes`
          + ((j.calls || []).length ? `, running ${j.calls.join(', ')}` : '') + ')', 'ok');
        else this._renderStatus('the sim refuses it: ' + (j.error || r.status), 'err');
      } catch (ex) {
        const errs = this.an.problems.filter(p => p.level === 'error');
        this._renderStatus(errs.length
          ? `no server to ask; the editor finds ${errs.length} error(s)`
          : 'no server to ask; the editor finds no errors', errs.length ? 'err' : 'ok');
      }
    }

    // ---- view sidecar ------------------------------------------------
    // Positions and labels are not part of the chart (decision 29), so they live here,
    // keyed by the behaviour's name, and follow it around on this machine.
    _viewStore() {
      try { return JSON.parse(global.localStorage.getItem(VIEW_KEY) || '{}') || {}; }
      catch (ex) { return this._memView || (this._memView = {}); }
    }
    _saveView() {
      const all = this._viewStore();
      all[this.name || SCRATCH] = { pos: this.pos, labels: this.labels };
      const keys = Object.keys(all);
      if (keys.length > 60) delete all[keys[0]];
      try { global.localStorage.setItem(VIEW_KEY, JSON.stringify(all)); }
      catch (ex) { this._memView = all; }
    }
    _saveViewSoon() {
      clearTimeout(this._viewT);
      this._viewT = setTimeout(() => this._saveView(), 400);
    }
    _loadViewFor(key) {
      const v = this._viewStore()[key];
      if (!v) return;
      for (const id in (v.pos || {})) if (this.g.nodes[id]) this.pos[id] = v.pos[id];
      for (const id in (v.labels || {})) if (this.g.nodes[id]) this.labels[id] = v.labels[id];
    }

    // ---- pointer -----------------------------------------------------
    _setSpace(on) {
      this._space = on;
      this.canvas.classList.toggle('fc-pannable', on);
    }
    _onDown(ev) {
      if (ev.button === 2) return;
      const port = ev.target.closest('.fc-port');
      if (port) return this._startLink(ev, port);
      const head = ev.target.closest('.fc-head');
      const node = ev.target.closest('.fc-node');
      if (head && node && !ev.target.closest('button, input, select, textarea')) return this._startMove(ev, node);
      if (node) return;                               // a field: let the browser handle it
      if (ev.button === 1 || this._space) return this._startPan(ev);
      this._startMarquee(ev);
    }
    _capture(ev, move, up) {
      const el = this.canvas;
      const id = ev.pointerId;
      const mv = e => { if (e.pointerId === id) move(e); };
      const fin = e => {
        if (e.pointerId !== undefined && e.pointerId !== id) return;
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', fin);
        el.removeEventListener('pointercancel', fin);
        try { el.releasePointerCapture(id); } catch (ex) { /* already gone */ }
        up(e);
      };
      try { el.setPointerCapture(id); } catch (ex) { /* not capturable */ }
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', fin);
      el.addEventListener('pointercancel', fin);
      ev.preventDefault();
    }
    _startPan(ev) {
      const v0 = { x: this.view.x, y: this.view.y };
      const s = { x: ev.clientX, y: ev.clientY };
      this.canvas.classList.add('fc-panning');
      this._capture(ev, e => {
        this.view.x = v0.x + (e.clientX - s.x);
        this.view.y = v0.y + (e.clientY - s.y);
        this._paint();
      }, () => this.canvas.classList.remove('fc-panning'));
    }
    _startMove(ev, node) {
      const id = node.dataset.id;
      if (ev.shiftKey) this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id);
      else if (!this.sel.has(id)) this.sel = new Set([id]);
      this.selEdge = null;
      const ids = this.sel.has(id) ? [...this.sel] : [id];
      const orig = {};
      for (const k of ids) orig[k] = { x: this.pos[k].x, y: this.pos[k].y };
      const s = { x: ev.clientX, y: ev.clientY };
      let moved = false;
      this.el.classList.add('fc-dragging');
      this._paint();
      this._renderStatus();
      this._capture(ev, e => {
        const dx = (e.clientX - s.x) / this.view.k, dy = (e.clientY - s.y) / this.view.k;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        for (const k of ids)
          this.pos[k] = { x: Math.max(0, Math.round(orig[k].x + dx)), y: Math.max(0, Math.round(orig[k].y + dy)) };
        this._paint();
      }, () => {
        this.el.classList.remove('fc-dragging');
        if (moved) this._commit();
        else { this.lit = this.lit === id ? null : id; this._paint(); }
      });
    }
    _startLink(ev, port) {
      const from = port.closest('.fc-node').dataset.id;
      const edge = port.dataset.port;
      const s = this._ports(from)[edge];
      port.classList.add('fc-port-hot');
      this.canvas.classList.add('fc-linking');
      let over = null;
      this._capture(ev, e => {
        const w = this._toWorld(e.clientX, e.clientY);
        this._linkPath = `<path class="fc-link" d="M ${s.x} ${s.y} C ${s.x} ${s.y + 40}, ${w.x} ${w.y - 40}, ${w.x} ${w.y}"/>`;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const n = el && el.closest && el.closest('.fc-node');
        if (over !== n) {
          if (over) over.classList.remove('fc-droptarget');
          over = n;
          if (over) over.classList.add('fc-droptarget');
        }
        this._paint();
      }, e => {
        this._linkPath = '';
        port.classList.remove('fc-port-hot');
        this.canvas.classList.remove('fc-linking');
        if (over) over.classList.remove('fc-droptarget');
        const el = e.clientX === undefined ? null : document.elementFromPoint(e.clientX, e.clientY);
        const drop = el && el.closest && el.closest('.fc-node');
        if (drop) this._setEdge(from, edge, drop.dataset.id);
        else if (el && this.canvas.contains(el)) this._dropMenu(e, from, edge);
        else this._paint();
      });
    }
    _dropMenu(ev, from, edge) {
      this._killMenu();
      const b = this.canvas.getBoundingClientRect();
      const at = this._toWorld(ev.clientX, ev.clientY);
      const m = document.createElement('div');
      m.className = 'fc-menu';
      m.style.left = (ev.clientX - b.left) + 'px';
      m.style.top = (ev.clientY - b.top) + 'px';
      m.innerHTML = `<span class="fc-menu-t">wire ${edge} to a new…</span>`
        + `<button data-new="decision">${GLYPH.decision} decision</button>`
        + `<button data-new="action">${GLYPH.action} action</button>`
        + `<button data-new="behaviour">${GLYPH.behaviour} behaviour</button>`;
      m.addEventListener('click', e => {
        const b2 = e.target.closest('button[data-new]');
        if (!b2) return;
        this._killMenu();
        const id = this._newNode(b2.dataset.new, { x: at.x + 120, y: at.y + 30 });
        this.g.nodes[from][edge] = id;
        this.sel = new Set([id]);
        this.render();
        this._commit();
      });
      this.canvas.appendChild(m);
      this._menu = m;
      this._paint();
      setTimeout(() => {
        this._menuOff = e => { if (!m.contains(e.target)) this._killMenu(); };
        global.addEventListener('pointerdown', this._menuOff, true);
      }, 0);
    }
    _killMenu() {
      if (this._menu) { this._menu.remove(); this._menu = null; }
      if (this._menuOff) { global.removeEventListener('pointerdown', this._menuOff, true); this._menuOff = null; }
    }
    _startMarquee(ev) {
      const b = this.canvas.getBoundingClientRect();
      const s = { x: ev.clientX - b.left, y: ev.clientY - b.top };
      const base = ev.shiftKey ? new Set(this.sel) : new Set();
      const box = document.createElement('div');
      box.className = 'fc-marquee';
      this.canvas.appendChild(box);
      let moved = false;
      this._capture(ev, e => {
        const c = { x: e.clientX - b.left, y: e.clientY - b.top };
        const l = Math.min(s.x, c.x), t = Math.min(s.y, c.y);
        const w = Math.abs(c.x - s.x), h = Math.abs(c.y - s.y);
        if (w + h > 4) moved = true;
        box.style.left = l + 'px'; box.style.top = t + 'px';
        box.style.width = w + 'px'; box.style.height = h + 'px';
        const p1 = this._toWorld(b.left + l, b.top + t);
        const p2 = this._toWorld(b.left + l + w, b.top + t + h);
        this.sel = new Set(base);
        for (const id in this.pos) {
          const p = this.pos[id], q = this._rectOf(id);
          if (p.x < p2.x && p.x + q.w > p1.x && p.y < p2.y && p.y + q.h > p1.y) this.sel.add(id);
        }
        this._paint();
        this._renderStatus();
      }, () => {
        box.remove();
        if (!moved) { this.sel = base; this.selEdge = null; this.lit = null; this._paint(); }
        this._renderStatus();
      });
    }
    _onWheel(ev) {
      ev.preventDefault();
      if (ev.shiftKey) {
        this.view.x -= ev.deltaX || ev.deltaY;
        this._paint();
        return;
      }
      this._zoomAt(this.view.k * Math.pow(0.9988, ev.deltaY), ev.clientX, ev.clientY);
    }
    _onDbl(ev) {
      const hit = ev.target.closest('.fc-hit');
      if (hit) {
        const [id, edge] = hit.dataset.edgeKey.split('|');
        this._setEdge(id, edge, '');
        this._renderStatus(`unwired ${id} ${edge}`);
        return;
      }
      if (!ev.target.closest('.fc-node')) { this.fit(); }
    }

    // ---- keyboard ----------------------------------------------------
    _onKey(ev) {
      if (!this.el.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (ev.code === 'Space' && !isTyping(ev.target)) { this._setSpace(true); ev.preventDefault(); return; }
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        ev.shiftKey ? this._restore(this._hi + 1) : this._restore(this._hi - 1);
        return;
      }
      if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); this._restore(this._hi + 1); return; }
      if (isTyping(ev.target)) {
        if (ev.key === 'Escape') ev.target.blur();
        return;
      }
      if (mod) {
        const k = ev.key.toLowerCase();
        if (k === 'a') { ev.preventDefault(); this.sel = new Set(Object.keys(this.g.nodes)); this._paint(); this._renderStatus(); }
        else if (k === 'c') { ev.preventDefault(); this._copy(); }
        else if (k === 'v') { ev.preventDefault(); this._paste(); }
        else if (k === 'd') { ev.preventDefault(); this._duplicate(); }
        return;
      }
      switch (ev.key) {
        case 'Delete': case 'Backspace':
          ev.preventDefault();
          if (this.selEdge) {
            const [id, edge] = this.selEdge.split('|');
            this.selEdge = null;
            this._setEdge(id, edge, '');
          } else this._delNodes([...this.sel]);
          break;
        case 'Escape':
          this._killMenu();
          this.sel.clear(); this.selEdge = null; this.lit = null;
          this._paint(); this._renderStatus();
          break;
        case '1': this._addNode('decision'); break;
        case '2': this._addNode('action'); break;
        case '3': this._addNode('behaviour'); break;
        case 'e': case 'E': if (this.sel.size === 1) this._setEntry([...this.sel][0]); break;
        case 'l': case 'L': this._tidy(); break;
        case 'f': case 'F': this.fit(); break;
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
          if (!this.sel.size) return;
          ev.preventDefault();
          const d = ev.shiftKey ? 40 : 4;
          const dx = ev.key === 'ArrowLeft' ? -d : ev.key === 'ArrowRight' ? d : 0;
          const dy = ev.key === 'ArrowUp' ? -d : ev.key === 'ArrowDown' ? d : 0;
          for (const id of this.sel)
            this.pos[id] = { x: Math.max(0, this.pos[id].x + dx), y: Math.max(0, this.pos[id].y + dy) };
          this._paint();
          clearTimeout(this._nudgeT);
          this._nudgeT = setTimeout(() => this._commit(), 400);
          break;
        }
      }
    }

    // ---- fields ------------------------------------------------------
    _onField(ev, committed) {
      const t = ev.target;
      if (!this.el.contains(t)) return;              // replaced under us

      if (t.classList.contains('fc-lib-find')) { this._renderLib(); return; }
      if (t.classList.contains('fc-lib-name')) return;
      if (t.classList.contains('fc-json')) return;

      if (t.classList.contains('fc-label')) {
        const id = t.closest('.fc-node').dataset.id;
        const v = t.value.trim();
        if (v) this.labels[id] = v; else delete this.labels[id];
        if (committed) { this._commit(); this._reflow(); } else this._saveViewSoon();
        return;
      }
      if (t.classList.contains('fc-behsel')) {
        if (!committed) return;
        this.g.nodes[t.closest('.fc-node').dataset.id].name = t.value || '';
        this.render();                                 // the whole analysis turns on the name
        this._commit();
        return;
      }
      if (t.classList.contains('fc-edge-sel')) {
        if (!committed) return;
        const id = t.closest('.fc-node').dataset.id;
        this.g.nodes[id][t.dataset.edge] = t.value || '';
        this.render();                                 // ports and badges follow the wiring
        this._commit();
        return;
      }
      const nodeEl = t.closest('.fc-node');
      if (!nodeEl || !t.closest('.fc-body') || !t.classList.contains('fc-text')) return;
      const id = nodeEl.dataset.id;
      if (t.tagName === 'TEXTAREA')                   // the box is as tall as what is in it
        t.rows = Math.max(1, t.value.split('\n').length);
      this._readNode(id);
      if (committed) { this._reflow(); this._commit(); }
      else { this.emit(); this._renderJSON(); }
    }

    // ---- clicks ------------------------------------------------------
    _onClick(ev) {
      const tab = ev.target.closest('.fc-tabs button');
      if (tab) return this._showTab(tab.dataset.tab);

      const prob = ev.target.closest('.fc-prob');
      if (prob) {
        const id = prob.dataset.prob;
        if (id && this.g.nodes[id]) { this.sel = new Set([id]); this._paint(); this._flash(id); this._renderStatus(); }
        return;
      }
      const ln = ev.target.closest('[data-load]');
      if (ln) return void this._load(ln.dataset.load);
      const cll = ev.target.closest('[data-call]');
      if (cll) return void this._call(cll.dataset.call);
      const ins = ev.target.closest('[data-insert]');
      if (ins) return void this._insert(ins.dataset.insert);
      const del = ev.target.closest('[data-delete]');
      if (del) return void this._delete(del.dataset.delete);

      const b = ev.target.closest('button[data-act]');
      if (b) {
        const nodeEl = ev.target.closest('.fc-node');
        const id = nodeEl && nodeEl.dataset.id;
        switch (b.dataset.act) {
          case 'add-decision': this._addNode('decision'); break;
          case 'add-action': this._addNode('action'); break;
          case 'add-behaviour': this._addNode('behaviour'); break;
          case 'entry': this._setEntry(id); break;
          case 'open-beh': this._load((this.g.nodes[id] || {}).name); break;
          case 'undo': this._restore(this._hi - 1); break;
          case 'redo': this._restore(this._hi + 1); break;
          case 'tidy': this._tidy(); break;
          case 'fit': this.fit(); break;
          case 'zoom-in': case 'zoom-out': {
            const c = this.canvas.getBoundingClientRect();
            this._zoomAt(this.view.k * (b.dataset.act === 'zoom-in' ? 1.2 : 1 / 1.2),
                         c.left + c.width / 2, c.top + c.height / 2);
            break;
          }
          case 'new':
            if (!this.dirty || global.confirm('Discard the unsaved changes to this chart?')) this._clearAll();
            break;
          case 'check': this._check(); break;
          case 'rail':
            this.el.classList.toggle('fc-rail-off');
            b.classList.toggle('fc-on', !this.el.classList.contains('fc-rail-off'));
            this._paint();
            break;
          case 'hints':
            this.hints = !this.hints;
            b.classList.toggle('fc-on', this.hints);
            this._renderProblems();
            break;
          case 'save': this._save(); break;
          case 'export': this._export(); break;
          case 'import': this._import(); break;
          case 'json-copy': this._jsonCopy(); break;
          case 'json-apply': this._jsonApply(); break;
          case 'del': this._delNodes([id]); break;
        }
        return;
      }

      // a word the checker offered, typed in for you: it replaces exactly what it faulted
      const fix = ev.target.closest('.fc-fix');
      if (fix) {
        const box = fix.closest('.fc-node');
        const t = box && box.querySelector('.fc-text');
        if (!t) return;
        const at = +fix.dataset.at, len = +fix.dataset.len, w = fix.dataset.ins;
        t.value = t.value.slice(0, at) + w + t.value.slice(at + len);
        t.focus();
        t.setSelectionRange(at + w.length, at + w.length);
        this._readNode(box.dataset.id);
        this._reflow();
        this._commit();
        return;
      }

      const hit = ev.target.closest('.fc-hit');
      if (hit) {
        this.selEdge = this.selEdge === hit.dataset.edgeKey ? null : hit.dataset.edgeKey;
        this.sel.clear();
        this._paint();
        this._renderStatus(this.selEdge ? 'edge selected' : '');
        return;
      }
      if (ev.target.closest('.fc-node') && !ev.target.closest('button, select, input, textarea, label')) {
        const id = ev.target.closest('.fc-node').dataset.id;
        if (!ev.shiftKey) this.sel = new Set([id]);
        this.selEdge = null;
        this._paint();
        this._renderStatus();
      }
    }

    // ---- files -------------------------------------------------------
    _export() {
      const name = (this.name || 'behaviour') + '.json';
      const blob = new Blob([JSON.stringify(this.g, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this._renderStatus('exported ' + name, 'ok');
    }
    _import() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const g = JSON.parse(rd.result);
            if (!g || typeof g !== 'object' || !g.nodes) throw new Error('no nodes object');
            this.setGraph(g, f.name.replace(/\.json$/i, ''));
            this._renderStatus('imported ' + f.name, 'ok');
          } catch (ex) { this._renderStatus('cannot read that file: ' + ex.message, 'err'); }
        };
        rd.readAsText(f);
      };
      inp.click();
    }
    _jsonCopy() {
      const text = JSON.stringify(this.g, null, 2);
      const done = () => this._renderStatus('json copied', 'ok');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => this._renderStatus('copy blocked', 'err'));
      else {
        const ta = this.el.querySelector('.fc-json');
        ta.select();
        document.execCommand('copy');
        done();
      }
    }
    _jsonApply() {
      const ta = this.el.querySelector('.fc-json');
      try {
        const g = JSON.parse(ta.value);
        if (!g || typeof g !== 'object' || !g.nodes) throw new Error('no nodes object');
        const keep = clone(this.pos), keepL = clone(this.labels);
        this.g = normGraph(g);
        this.pos = {};
        this.labels = {};
        for (const id in keep) if (this.g.nodes[id]) this.pos[id] = keep[id];
        for (const id in keepL) if (this.g.nodes[id]) this.labels[id] = keepL[id];
        for (const id of [...this.sel]) if (!this.g.nodes[id]) this.sel.delete(id);
        this.render();
        this._commit();
        this._renderStatus('json applied', 'ok');
      } catch (ex) { this._renderStatus('not a chart: ' + ex.message, 'err'); }
    }
  }

  Flowchart.empty = emptyGraph;
  Flowchart.analyse = analyse;
  Flowchart.grammar = () => clone(G);
  global.Flowchart = Flowchart;
})(typeof window !== 'undefined' ? window : globalThis);
