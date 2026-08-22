const SIZE = 17, SQ3 = Math.sqrt(3);
const STATC = {hp:'--hp', speed:'--speed', sense:'--sense'};
// decision 24: one code across map, rule text and log. Hue names the stat, the +/- glyph
// names the direction -- the same (stat, sign) pair that types actions and keys skill.
const STATSYM = {hp:'\u2665', speed:'\u00bb', sense:'\u25c9'};
const ARCH    = {gatherer:'#4ade80', raider:'#ef4444', giver:'#60a5fa',
                 wanderer:'#94a3b8', inert:'#5b6675'};
const ARCHSYM = {gatherer:'\u25cf', raider:'\u25b2', giver:'\u25c6',
                 wanderer:'\u25a0', inert:'\u25cb'};
// an outcome that delivered nothing still says something: mark it on the actor
const MARK = {wasted:['?', '#c9a24a'], blocked:['\u2298', '#c08a68'],
              idle:['\u00b7', '#5a6473'], hold:['\u25e6', '#5a6473']};
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
let S = null, sel = null, selCell = null, filt = null, playing = null, showTrails = false, showActs = true;
let zoom = 1, panX = 0, panY = 0, drag = null, dragged = false;
let focus = null;   // the event a log row points at: actor, counterparty, target cell

const cssvar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = {position:'#8fa3bb'};
for (const k in STATC) COL[k] = cssvar(STATC[k]);
for (const k of ['bad', 'give', 'dim', 'focus']) COL[k] = cssvar('--' + k);
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
// a glyph on a tinted cell has to beat its own hue, so labels use a lightened stat colour
const lighten = (col, t) => {
  const n = parseInt(col.slice(1), 16), m = v => Math.round(v + (255 - v) * t);
  return `rgb(${m(n >> 16 & 255)},${m(n >> 8 & 255)},${m(n & 255)})`;
};
const LIT = {};
for (const k in COL) if (COL[k][0] === '#') LIT[k] = lighten(COL[k], .5);
const px = (q, r) => [SIZE * SQ3 * (q + r / 2), SIZE * 1.5 * r];

// The canvas fills whatever box the layout gives it; `base` is the world->CSS scale that
// makes the whole field fit that box, so zoom stays a user-relative multiplier (1 = fits).
let view = {w: 1, h: 1, dpr: 1, base: 1};
function fit() {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  const R = S ? S.radius : 0;
  view = {w, h, dpr,
          base: Math.min(w / (SIZE * SQ3 * (2 * R + 2) + 20),
                         h / (SIZE * 1.5  * (2 * R + 2) + 20))};
}
const centre = () => [view.w / 2, view.h / 2];
const scale  = () => view.base * zoom;   // world units -> CSS px

function hexPath(x, y, s) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    const vx = x + s * Math.cos(a), vy = y + s * Math.sin(a);
    i ? ctx.lineTo(vx, vy) : ctx.moveTo(vx, vy);
  }
  ctx.closePath();
}

function pixelToHex(mx, my) {
  const [cx, cy] = centre();
  const k = scale();
  const x = (mx - cx - panX) / k, y = (my - cy - panY) / k;
  const r = (2 / 3 * y) / SIZE, q = (SQ3 / 3 * x - y / 3) / SIZE;
  let rx = Math.round(q), rz = Math.round(r), ry = Math.round(-q - r);
  const dx = Math.abs(rx - q), dz = Math.abs(rz - r), dy = Math.abs(ry - (-q - r));
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dz > dy) rz = -rx - ry;
  return [rx, rz];
}

// A glyph is always sign-then-stat, the sign in its polarity colour and the symbol in the
// stat's, so a cell, a landed blow and a rule line all read the same way.
function glyph(x, y, sign, sym, col, size, bold) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${MONO}`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const sg = sign > 0 ? '+' : '\u2212', wS = ctx.measureText(sg).width;
  const x0 = x - (wS + ctx.measureText(sym).width) / 2;
  ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(6,10,16,.92)';
  ctx.strokeText(sg, x0, y); ctx.strokeText(sym, x0 + wS, y);
  ctx.fillStyle = sign > 0 ? LIT.give : LIT.bad; ctx.fillText(sg, x0, y);
  ctx.fillStyle = col; ctx.fillText(sym, x0 + wS, y);
}

function mark(x, y, ch, col, size) {
  ctx.font = `bold ${size}px ${MONO}`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(8,12,18,.9)';
  ctx.strokeText(ch, x, y);
  ctx.fillStyle = col; ctx.fillText(ch, x, y);
}

// An act has a direction and the map has to say it, or two bodies joined by a line are
// just a relation and the reader has to guess which end did the thing. So: a dot on the
// tail is the body that acted, the head is what it acted on. Both ends are pulled back
// off the centres by `pad`, so the head lands beside the target rather than under it and
// the tail sits on the actor's rim rather than inside it.
// `lane` shifts the whole arrow onto its own right-hand side of the line, so two entities
// that acted on each other this tick draw as two parallel arrows instead of one line with a
// head at each end -- the case where the direction mattered most and was hardest to read.
function arrow(x0, y0, x1, y1, col, {dash = null, width = 1.5, pad0 = 0, pad1 = 0,
                                     alpha = 1, head = 7, lane = 0} = {}) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const lx = -uy * lane, ly = ux * lane;
  const ax = x0 + ux * pad0 + lx, ay = y0 + uy * pad0 + ly;   // tail: on the actor
  const bx = x1 - ux * pad1 + lx, by = y1 - uy * pad1 + ly;   // head: on the acted-on
  ctx.save();
  ctx.globalAlpha = alpha; ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = width;
  if ((bx - ax) * ux + (by - ay) * uy > head) {       // adjacent bodies leave no shaft to draw
    ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx - ux * head, by - uy * head); ctx.stroke();
    ctx.setLineDash([]);
  }
  const w = head * .58;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - ux * head + uy * w, by - uy * head - ux * w);
  ctx.lineTo(bx - ux * head - uy * w, by - uy * head + ux * w);
  ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(ax, ay, 2.3, 0, 7); ctx.fill();
  ctx.restore();
}

// what the ground does: hue is the stat it moves, the glyph the direction, the fill height
// how much is left, and hatching that it takes rather than gives (decision 11).
// A cell holding less than one whole unit is drawn as a bare outline: the wild yields in
// units, so an unripe patch is a promise, not a source, and nothing can be taken from it.
function drawCell(cx, cy, c) {
  const [dx, dy] = px(c.q, c.r), X = cx + dx, Y = cy + dy, s = SIZE - 1;
  const frac = Math.min(1, c.amount / Math.max(1, c.cap));
  if (!c.ripe) {
    ctx.save();
    ctx.globalAlpha = .30; ctx.strokeStyle = c.delta < 0 ? COL.bad : (COL[c.stat] || COL.hp);
    ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    hexPath(X, Y, s * .62); ctx.stroke();
    ctx.restore();
    return;
  }
  const col = COL[c.stat] || COL.hp, neg = c.delta < 0;
  ctx.save();
  hexPath(X, Y, s); ctx.clip();
  ctx.globalAlpha = .34; ctx.fillStyle = neg ? COL.bad : col;
  ctx.fillRect(X - SIZE, Y + s - 2 * s * frac, SIZE * 2, 2 * s * frac);
  ctx.globalAlpha = 1;
  if (neg) {
    ctx.strokeStyle = 'rgba(239,68,68,.30)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = -2 * SIZE; i < 2 * SIZE; i += 7) {
      ctx.moveTo(X + i, Y - s); ctx.lineTo(X + i + 2 * s, Y + s);
    }
    ctx.stroke();
  }
  ctx.restore();
  hexPath(X, Y, s); ctx.lineWidth = 1;
  if (neg) { ctx.setLineDash([3, 2]); ctx.strokeStyle = 'rgba(239,68,68,.8)'; }
  else { ctx.strokeStyle = col; ctx.globalAlpha = .4; }
  ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  if (!c.wild) {                      // corpse loot, not wild growth
    hexPath(X, Y, s - 4); ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(226,232,240,.5)'; ctx.stroke(); ctx.setLineDash([]);
  }
  glyph(X, Y, c.delta, STATSYM[c.stat] || '?', LIT[c.stat] || LIT.hp,
        8.5 + Math.min(2.5, Math.abs(c.delta)), true);
}

// a body's silhouette is what it has been doing (decision 3's after-the-fact naming), so
// shape and hue carry the same fact twice and neither has to be looked up
function shape(kind, x, y, r) {
  ctx.beginPath();
  if (kind === 'raider') {
    ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.05, y + r * .8);
    ctx.lineTo(x - r * 1.05, y + r * .8); ctx.closePath();
  } else if (kind === 'giver') {
    ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.1, y);
    ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 1.1, y); ctx.closePath();
  } else if (kind === 'wanderer') {
    ctx.rect(x - r * .95, y - r * .95, r * 1.9, r * 1.9);
  } else ctx.arc(x, y, r, 0, 7);                    // gatherer, inert
}

const actHue = v => v.kind === 'gather' ? (COL[v.stat] || COL.hp)
              : v.kind === 'give' ? COL.give
              : (v.kind === 'harm' || v.kind === 'hazard') ? COL.bad : '#5c6b7d';

// the tick's actions, drawn as what they are: an arrow out of the body that acted and into
// the thing it acted on, coloured by the (stat, sign) it delivered. The direction is the
// same for every kind -- dot = actor, head = acted on -- so who did what to whom is read
// off the drawing and never has to be inferred from the log. What moved is written where
// it landed: on the victim or the receiver for a blow or a gift, on the actor itself for a
// draw from the ground, which is the one act whose payload travels back up the arrow.
function drawAct(cx, cy, e, v) {
  const [ex, ey] = px(e.q, e.r), X = cx + ex, Y = cy + ey;
  const col = actHue(v);
  if (v.kind === 'move') {
    const [fx, fy] = px(v.frm[0], v.frm[1]);
    arrow(cx + fx, cy + fy, X, Y, col, {width: 1.5, pad1: 10, alpha: .85, lane: 2.5});
    return;
  }
  if (!v.target) return;
  const [tx, ty] = px(v.target[0], v.target[1]), TX = cx + tx, TY = cy + ty;
  const onBody = v.kind === 'harm' || v.kind === 'give';   // landed on someone, not on ground
  arrow(X, Y, TX, TY, col, {dash: [4, 3], width: 1.5, pad0: 8,
                            pad1: onBody ? 11 : 7, alpha: .85, lane: 2.5});
  if (onBody)                        // what it moved, over the head it landed on
    glyph(TX, TY - 14, v.kind === 'give' ? 1 : -1, STATSYM[v.stat] || '?',
          LIT[v.stat] || LIT.hp, 11, true);
  else if (v.kind === 'gather' || v.kind === 'hazard')     // what came back out of the ground
    glyph(X, Y - 14, v.got < 0 ? -1 : 1, STATSYM[v.stat] || '?',
          v.kind === 'hazard' ? LIT.bad : (LIT[v.stat] || LIT.hp), 10.5, true);
}

function draw() {
  if (!S) return;
  const [cx, cy] = centre();
  const k = scale(), d = view.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  // camera: scale world coords (which are centre + hex offset) around the centre, then pan --
  // all in CSS px, with the device-pixel ratio folded in so the backing store stays crisp
  ctx.setTransform(d * k, 0, 0, d * k, d * (cx * (1 - k) + panX), d * (cy * (1 - k) + panY));

  // empty field
  const R = S.radius;
  ctx.strokeStyle = '#161e28'; ctx.lineWidth = 1;
  for (let q = -R; q <= R; q++)
    for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
      const [x, y] = px(q, r);
      hexPath(cx + x, cy + y, SIZE - 1); ctx.stroke();
    }

  // resource cells (decision 11)
  for (const c of S.cells) drawCell(cx, cy, c);

  // trails (decision 4: position is a stat, so this is just its history)
  const trailFor = e => {
    if (e.trail.length < 2) return;
    ctx.beginPath();
    e.trail.forEach((p, i) => {
      const [x, y] = px(p[0], p[1]);
      i ? ctx.lineTo(cx + x, cy + y) : ctx.moveTo(cx + x, cy + y);
    });
    ctx.stroke();
  };
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  if (showTrails) {
    ctx.strokeStyle = 'rgba(201,211,224,.16)';
    S.ents.filter(e => e.alive).forEach(trailFor);
  }
  if (sel) {
    const e = S.ents.find(e => e.id === sel);
    if (e) { ctx.strokeStyle = 'rgba(96,165,250,.75)'; trailFor(e); }
  }

  // sense radius of the selection (decision 9), and inside it the read radius where other
  // entities' stats become legible (decision 23)
  if (sel) {
    const e = S.ents.find(e => e.id === sel);
    if (e && e.alive) {
      const [x, y] = px(e.q, e.r);
      const ring = (hexes, style, dash) => {
        ctx.beginPath();
        ctx.arc(cx + x, cy + y, Math.max(1, hexes) * SIZE * SQ3 + SIZE * .5, 0, 7);
        ctx.strokeStyle = style; ctx.setLineDash(dash);
        ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      };
      ring(Math.round(e.stat.sense), 'rgba(167,139,250,.35)', [4, 4]);
      ring(e.read,                   'rgba(167,139,250,.55)', [1, 3]);
    }
  }

  // this tick's action, under the body that made it -- one per entity (decision 31),
  // though a wasted turn logs alongside the thing that wasted it
  const acts = {};
  for (const v of S.events) if (v.t === S.tick) (acts[v.e] || (acts[v.e] = [])).push(v);
  if (showActs)
    for (const e of S.ents) if (e.alive && acts[e.id])
      for (const v of acts[e.id]) drawAct(cx, cy, e, v);

  // entities
  for (const e of S.ents) {
    if (!e.alive) continue;
    const [x, y] = px(e.q, e.r), X = cx + x, Y = cy + y;
    const hp = Math.max(0, Math.min(1, e.stat.hp / statMax('hp')));
    const rad = 4 + 4 * hp;                          // size is hp
    const col = ARCH[e.archetype] || '#94a3b8';
    shape(e.archetype, X, Y, rad);
    ctx.fillStyle = e.archetype === 'inert' ? '#0d1117' : col; ctx.fill();
    ctx.lineWidth = e.id === sel ? 2.5 : 1;
    ctx.strokeStyle = e.id === sel ? '#fff'
                    : e.archetype === 'inert' ? col : '#0d1117';
    ctx.stroke();
    if (e.condition < 0.75) {                        // strain ring: thicker = worse off
      ctx.beginPath(); ctx.arc(X, Y, rad + 4, 0, 7);
      ctx.strokeStyle = `rgba(239,68,68,${0.25 + 0.6 * (1 - e.condition)})`;
      ctx.lineWidth = 1 + 2 * (1 - e.condition); ctx.stroke();
    }
    const evs = acts[e.id];
    const m = showActs && evs && evs.length && MARK[evs[evs.length - 1].kind];
    if (m) mark(X + rad + 5, Y - rad - 2, m[0], m[1], 10);
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(8,12,18,.9)';
    ctx.strokeText(e.id, X, Y + rad + 5);
    ctx.fillStyle = e.id === sel ? '#fff' : '#8fa3bb';
    ctx.fillText(e.id, X, Y + rad + 5);
  }
  if (focus) {
    // the read of one row of the log: both ends named in words, because a highlight on two
    // bodies says they were involved and not which of them did it. The actor carries the
    // verb, the other party carries what the verb did to it.
    const at = id => { const e = S.ents.find(e => e.id === id); return e ? px(e.q, e.r) : null; };
    const a = at(focus.actor);
    const tgt = focus.cell ? px(focus.cell[0], focus.cell[1]) : null;
    if (a && tgt)                                     // the reach of the action
      arrow(cx + a[0], cy + a[1], cx + tgt[0], cy + tgt[1], COL.focus,
            {dash: [5, 3], width: 2, pad0: 11, pad1: focus.other !== null ? 13 : 10,
             head: 9, lane: 2.5});   // the same lane the act itself was drawn in
    if (tgt) {                                        // the cell it landed on
      hexPath(cx + tgt[0], cy + tgt[1], SIZE - 1);
      ctx.strokeStyle = COL.focus; ctx.lineWidth = 2; ctx.stroke();
    }
    if (a) {                                          // the body that acted
      ctx.beginPath(); ctx.arc(cx + a[0], cy + a[1], 12, 0, 7);
      ctx.strokeStyle = COL.focus; ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]);
      ctx.stroke(); ctx.setLineDash([]);
      mark(cx + a[0], cy + a[1] - 26, `e${focus.actor} ${focus.verb}`, COL.focus, 10);
    }
    const o = focus.other !== null ? at(focus.other) : null;
    if (o) {                                          // the other party
      ctx.beginPath(); ctx.arc(cx + o[0], cy + o[1], 11, 0, 7);
      ctx.strokeStyle = COL.focus; ctx.lineWidth = 2.5; ctx.stroke();
      mark(cx + o[0], cy + o[1] - 26, `${focus.role} e${focus.other}`, COL.focus, 10);
    }
  }
  if (selCell) {
    const [x, y] = px(selCell[0], selCell[1]);
    hexPath(cx + x, cy + y, SIZE - 1);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

// ---- conditions/actions read back as the words they were written in: the written form of
// the grammar (syntax.js, the browser's mirror of sim/syntax.py), rendered from the chart
// nodes themselves, so the description cannot drift from what the sim runs.
const stTok  = s => `<span class="s-${s}">${STATSYM[s] || ''} ${s}</span>`;
const sgTok  = n => n > 0 ? '<span class="plus">+</span>' : '<span class="minus">\u2212</span>';
const kw     = t => `<span class="kw">${t}</span>`;
const esc    = t => String(t).replace(/[&<>]/g,
                     c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));

// ---- flow-chart viewer (decision 26). The inspector shows the selected entity's chart
// read-only and in words; authoring happens in /flowchart. A tick walks the chart once from
// start and the first action it reaches is the whole turn (decision 31), so an action is
// always where a branch ends -- which makes the chart an if / else-if ladder, and that is
// how it reads here: one row per branch, the test on the left, the turn that branch spends
// on the right. Node ids are the editor's business, not the reader's, so they stay out of
// it; the only ones that surface are the join points a tree cannot express, where a
// decision two edges reach is drawn once under a label and referred to by it.
// A decision's conditions all have to hold, which is what the editor's one-per-line box
// means, so they read here joined by `and`.
const OPSYM = {'<=': '≤', '>=': '≥', '!=': '≠', '==': '='};
// the words the grammar spends on saying what is being measured, as against the values
const CONDW = new RegExp('^(dist|distance|count|n|amount|left|entity|entities|body|one'
                       + '|source|cell|patch|nearest|closest|the|a|my|own|i|their|other'
                       + '|its|it|them|always|and)$');
const STATS = Object.keys(STATC).join('|');
const STATRE = new RegExp(`([+\\-])?\\b(${STATS})\\b|(?:u|my)\\.(?:max_)?(?:${STATS})|(<=|>=|!=|==|<|>|=)`
                          + `|(\\d+(?:\\.\\d+)?)|([A-Za-z_][\\w.]*)|([\\s\\S])`, 'g');

const SUBJRE = /^(?:u|my)\./;   // `u.hp`, `my.hp`, `my.max_hp` -- a reading of yourself

// a test in the same code as the map and the log (decision 24): hue names the stat, the
// +/- glyph names the direction, and a threshold that is an expression keeps the cyan the
// editor gives it. Written text in, coloured HTML out -- escaping as it goes.
function testHTML(text) {
  let out = '', m;
  STATRE.lastIndex = 0;
  while ((m = STATRE.exec(text))) {
    if (m[2]) out += (m[1] ? sgTok(m[1] === '-' ? -1 : 1) : '') + stTok(m[2]);
    else if (SUBJRE.test(m[0])) out += `<span class="num expr">${esc(m[0])}</span>`;
    else if (m[3]) out += `<span class="op">${esc(OPSYM[m[3]] || m[3])}</span>`;
    else if (m[4]) out += `<span class="num">${m[4]}</span>`;
    else if (m[5]) out += CONDW.test(m[5]) ? kw(esc(m[5])) : esc(m[5]);
    else out += esc(m[0]);
  }
  return out;
}

// the glyph and hue the log gives an act, so a branch is recognisable as the event it becomes
function actMark(a) {
  if (typeof a === 'string') {                  // a chart straight off disk, still in words
    try { a = ChartSyntax.parseAct(a); } catch (ex) { return ['·', COL.dim]; }
  }
  if (!a) return ['·', COL.dim];
  if (a[0] === 'move') return [a[2] > 0 ? '→' : '←', COL.position];
  const sel = a[1] || [];
  if (sel[0] === 'source')                      // a draw from a source: a gift or a hazard
    return sel[2] > 0 ? ['↓', COL.hp] : ['▤', '#e08d5a'];
  return a[3] > 0 ? ['✚', COL.give] : ['✕', COL.bad];
}

const isAlways = cs => (cs || []).length === 1
  && (cs[0] === 'always' || (Array.isArray(cs[0]) && cs[0][0] === 'always'));

// Which called behaviours the reader has opened up, keyed by the path of calls that reaches
// one, so the panel re-rendering every tick does not fold them shut again.
const BEHOPEN = new Set();

// `path` names where this chart hangs off the entity's own -- '' for the top-level chart,
// then one segment per call stepped into, so the same node id inside two different called
// charts is two different folds.
function chartHTML(chart, path = '') {
  const nodes = chart && chart.nodes;
  if (!nodes || !Object.keys(nodes).length) return '<span class="empty">no chart</span>';
  const at = id => (id && nodes[id]) || null;
  const entry = at(chart.entry) ? chart.entry : null;
  // how many edges a walk can arrive by -- an action's `next` is not one of them, since the
  // turn ends at the action, so it never makes a node look shared
  const deg = {};
  if (entry) deg[entry] = 1;                 // every tick arrives at the entry from the top
  for (const id in nodes) {
    const t0 = nodes[id].type;
    // a call does come back, so what follows one is arrived at; an action's `next` is not,
    // since the turn ends at the action
    const edges = t0 === 'decision' ? [nodes[id].yes, nodes[id].no]
                : t0 === 'behaviour' ? [nodes[id].next] : [];
    for (const t of edges) if (at(t)) deg[t] = (deg[t] || 0) + 1;
  }
  const lab = {}, drawn = new Set();
  let n = 0;
  const labelOf = id => lab[id] || (lab[id] = String.fromCharCode(65 + n++));
  const ref = id => `<span class="does ref" title="the same test again, drawn above">`
                  + `↻ ${esc(labelOf(id))}</span>`;

  // a call drawn as the unit it is -- its name -- and, when the reader has opened it, the
  // chart it runs underneath. Split in two so a call that ends its branch can sit on the
  // test's own row with its insides still folding out below that row.
  const callHTML = id => {
    const nd = nodes[id], nm = nd.name || '?', key = path + '/' + id;
    const has = !!(nd.chart && nd.chart.nodes), open = has && BEHOPEN.has(key);
    return `<span class="does beh${has ? ' fold' : ''}"`
      + (has ? ` data-beh="${esc(key)}"` : '')
      + ` title="${esc('runs the saved behaviour ' + nm
          + (goesOn(nd.next) ? ', then carries on below' : '')
          + (has ? open ? ' — click to fold it away' : ' — click to see what it does' : ''))}">`
      + (has ? `<span class="caret">${open ? '▾' : '▸'}</span>` : '')
      + `⬡ ${esc(nm)}</span>`;
  };
  const callBlk = id => {
    const nd = nodes[id], key = path + '/' + id;
    return nd.chart && nd.chart.nodes && BEHOPEN.has(key)
      ? `<div class="blk beh-in">${chartHTML(nd.chart, key)}</div>` : '';
  };
  // does anything follow this node once the walk comes back from it
  const goesOn = id => !!at(id);

  // where a branch ends: the one act it spends the turn on, the one call it hands the turn
  // to, or no turn spent at all. Null when the branch has more ladder to draw -- another
  // test, or a call with rows still to come under it.
  const NOTHING = '<span class="does none" title="the tick passes">◦ nothing</span>';
  const spend = id => {
    const nd = at(id);
    if (!nd) return NOTHING;
    // a call with nothing wired after it ends its branch exactly as an action does, so it
    // reads on the test's row rather than as an unled line of its own below it
    if (nd.type === 'behaviour')
      return !goesOn(nd.next) && (deg[id] || 0) <= 1 ? callHTML(id) : null;
    if (nd.type !== 'action') return null;                 // a test has more to draw
    const [g, c] = actMark(nd.act);
    const on = goesOn(nd.next)
      ? ' <span class="dead" title="never runs: the turn ends at this action and the next'
        + ' tick starts again at the top">⋯</span>' : '';
    return `<span class="does" style="color:${c}">${g} ${esc(ChartSyntax.actText(nd.act))}`
         + `</span>${on}`;
  };
  // what hangs under the row a branch's spend was drawn on -- an opened call, and nothing else
  const under = id => at(id) && nodes[id].type === 'behaviour' ? callBlk(id) : '';
  // `if` and `else if` promise a test; a row that carries none must not use them
  const bare = lead => lead === 'else if' ? 'else' : lead === 'if' ? '' : lead;
  // the arrow only earns its place between a test and what passing it costs the turn, and
  // it travels with the act: arrow and act are one group, so when the panel is too narrow
  // to hold test and act side by side the whole `→ act` drops to its own line, still flush
  // right, instead of the test being crushed into a column one word wide.
  const row = (lead, test, does) =>
    `<div class="ln"><span class="lead">${lead}</span>`
    + (test ? `<span class="test">${test}</span>` : '')
    + (does ? `<span class="then">${test ? '<span class="arw">→</span>' : ''}${does}</span>` : '')
    + '</div>';

  // One rung of the ladder, and everything below it: the `no` side carries on beside this
  // row as `else if`, so a chart that only ever branches on `no` -- the usual shape -- comes
  // out as one flat list of "when this, do that". A `yes` side that tests again nests, since
  // its tests only apply inside this one.
  const rung = (id, lead) => {
    const leaf = spend(id);
    if (leaf) return row(bare(lead), '', leaf) + under(id);
    if (drawn.has(id)) return row(bare(lead), '', ref(id));
    drawn.add(id);
    const nd = nodes[id];
    // a call with more under it: the named chart runs here and the walk comes back, so
    // whatever it leaves undone carries on underneath. It shares this tick's one action, so
    // if the call spends it, what is drawn below runs only on the ticks the call spent
    // nothing. The call itself stays one line until asked -- a chart that runs three saved
    // behaviours reads as three lines, not as all of their insides at once.
    if (nd.type === 'behaviour') {
      let out = row(bare(lead), '', callHTML(id)) + callBlk(id);
      if (goesOn(nd.next)) out += rung(nd.next, 'then');
      return out;
    }
    const yes0 = spend(nd.yes);
    // `always` is not a fork: nothing can take its no side, so it is not drawn as one
    if (isAlways(nd.conds))
      return yes0 ? row(lead === 'if' ? 'always' : 'else', '', yes0) + under(nd.yes)
                  : rung(nd.yes, lead === 'if' ? 'always' : 'else');
    const test = (deg[id] > 1 ? `<span class="lbl">${esc(labelOf(id))}</span>` : '')
      + testHTML(ChartSyntax.condsText(nd.conds).split('\n').join(' and '));
    const yes = yes0, no = spend(nd.no);
    let out = row(lead, test, yes || '');
    if (yes) out += under(nd.yes);
    else out += `<div class="blk">${rung(nd.yes, 'if')}</div>`;
    // a no side that spends nothing is the ladder simply running out, which the last rung
    // already says -- an `else nothing` row only adds a line to read
    if (no === NOTHING) return out;
    if (no) out += row('else', '', no) + under(nd.no);
    else if (drawn.has(nd.no)) out += row('else', '', ref(nd.no));
    // a call under `else` keeps its own rows with it, indented, rather than trailing them
    // off the ladder where they would read as belonging to no branch at all
    else if (nodes[nd.no].type === 'behaviour')
      out += row('else', '', '') + `<div class="blk">${rung(nd.no, '')}</div>`;
    else out += rung(nd.no, 'else if');
    return out;
  };

  const top = spend(entry);
  let html = top ? row('always', '', top) + under(entry) : rung(entry, 'if');
  // A node no edge at all arrives at is not part of the behaviour, but saying so beats
  // dropping it in silence -- an authored chart with an orphan looks finished otherwise.
  // (What sits past an action is linked, just never run; the row marks that itself.)
  const live = new Set();
  (function mark(id) {
    if (!at(id) || live.has(id)) return;
    live.add(id);
    mark(nodes[id].next); mark(nodes[id].yes); mark(nodes[id].no);
  })(entry);
  const orphan = Object.keys(nodes).filter(id => !live.has(id));
  if (orphan.length) html += `<div class="ln"><span class="lead"></span>`
    + `<span class="empty" title="no walk from the entry reaches these">`
    + `${esc(orphan.join(', '))} unreachable</span></div>`;
  return html;
}
let BEHAVIOURS = {};
async function loadBehaviours() {
  try { BEHAVIOURS = (await (await fetch('/api/behaviours')).json()).behaviours || {}; }
  catch (e) { BEHAVIOURS = {}; }
}
const behOptions = () => {
  const names = Object.keys(BEHAVIOURS);
  return names.length ? names.map(n => `<option value="${n}">${n}</option>`).join('')
    : '<option value="">(no saved behaviours)</option>';
};
async function assignChart(graph) {
  if (sel === null) return;
  const r = await fetch('/api/rules', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sel, chart: graph }) });
  const j = await r.json();
  const box = document.getElementById('err');
  if (!r.ok) { if (box) box.textContent = ' ' + (j.error || 'rejected'); return; }
  S = j; render();
}

document.getElementById('inspx').onclick = () => {
  sel = selCell = filt = null; focus = null; render();
};

const selBox = document.getElementById('sel');
selBox.addEventListener('click', ev => {
  const fold = ev.target.closest && ev.target.closest('[data-beh]');
  if (fold) {
    const key = fold.dataset.beh;
    if (BEHOPEN.has(key)) BEHOPEN.delete(key); else BEHOPEN.add(key);
    renderSel();
    return;
  }
  if (ev.target.id === 'beh-assign') {
    const name = document.getElementById('beh').value;
    const graph = name && BEHAVIOURS[name];
    if (graph) assignChart(graph);
  }
});

// Stats are rolled at birth (decision 35), so a bar is scaled to the top of the opening
// range -- START plus its spread -- and not to START itself, which is only the mean.
// A capped stat (decision 36) is the exception: its bar reads against *this* entity's own
// ceiling, so a full bar means full and not "as much as anyone here was born with".
function statMax(k, e) {
  const g = S && S.grammar || {};
  if (e && e.max && e.max[k]) return e.max[k];
  const base = (g.start || {})[k], spread = (g.spread || {})[k] || 0;
  return base ? base + spread : (k === 'hp' ? 26 : k === 'sense' ? 8 : 5);
}

function bar(v, max, col) {
  const w = Math.max(1, Math.round(52 * Math.min(1, v / max)));
  return `<span class="bar" style="width:${w}px;background:${cssvar(col)}"></span>`;
}

function renderSel() {
  const box = document.getElementById('sel');
  document.getElementById('filter').textContent = filt !== null ? `· e${filt} \u2715` : '';
  // nothing selected is not an empty panel -- it is no panel, and the map gets the room
  document.getElementById('insp').hidden = sel === null && !selCell;
  if (sel === null) {
    if (selCell) {
      const c = S.cells.find(c => c.q === selCell[0] && c.r === selCell[1]);
      box.innerHTML = c
        ? `<b>cell</b> ${hexTok(c.q, c.r)} ${sgTok(c.delta)}${stTok(c.stat)}
           <table><tr><td class="k">amount</td><td>${c.amount} / ${c.cap}
             <span class="kw">${'█'.repeat(Math.round(8*Math.min(1,c.amount/Math.max(1,c.cap))))}</span></td></tr>
           <tr><td class="k">ripe</td><td>${c.ripe
             ? `<span class="plus">yes</span> <span class="kw">— ${Math.floor(c.amount)} unit${Math.floor(c.amount)===1?'':'s'} to draw, one per act</span>`
             : `<span class="empty">not yet</span> <span class="kw">— under a whole unit, nothing to take</span>`}</td></tr>
           <tr><td class="k">origin</td><td>${c.wild ? 'wild' : 'corpse loot'}</td></tr></table>`
        : `<b>cell</b> ${hexTok(selCell[0], selCell[1])} <span class="empty">empty ground</span>`;
      return;
    }
    return;
  }
  const e = S.ents.find(e => e.id === sel);
  if (!e) { box.innerHTML = '<span class="empty">gone</span>'; return; }
  box.innerHTML = `
    <div style="margin-bottom:6px">
      <b>e${e.id}</b> · <span title="spawned as">${e.arch}</span> · ${e.archetype} · ${hexTok(e.q, e.r)}
      ${focus && focus.other !== null ? `<span style="color:var(--speed)">↔ e${focus.other}</span>` : ''}
      ${e.alive ? '' : `<span class="death">DEAD t${e.died}</span>`}
    </div>
    <table>
      <tr><td class="k">hunger</td><td>${bar(e.hunger, 16, e.bite ? '--bad' : '--speed')}${e.hunger}
        <span class="kw">${e.bite
          ? `— biting ×${e.bite}`
          : `— fed, ${S.tuning.HUNGER_GRACE - e.hunger} free turn${S.tuning.HUNGER_GRACE - e.hunger === 1 ? '' : 's'} left`}</span></td></tr>
      <tr><td class="k">strain</td><td>${bar(e.strain, 25, '--bad')}${e.strain}</td></tr>
      <tr><td class="k">condition</td><td>${bar(e.condition, 1, '--speed')}${(e.condition*100).toFixed(0)}%</td></tr>
      <tr><td class="k">pace</td><td>${(e.stat.speed * e.condition).toFixed(2)}</td></tr>
    </table>
    <table>${Object.entries(e.stat).map(([k, v]) => {
      const cap = e.max && e.max[k];       // decision 36: read it as v / ceiling
      return `<tr><td class="k" style="color:${COL[k]}">${STATSYM[k]} ${k}</td>
           <td>${bar(v, statMax(k, e), STATC[k])}${v}${cap
             ? ` <span class="kw">/ ${cap}${v >= cap ? ' — full' : ''}</span>` : ''}</td></tr>`;
    }).join('')}</table>
    <h2 style="margin:9px 0 5px">behaviour</h2>
    <div class="chart">${chartHTML(e.chart, 'e' + e.id)}</div>
    <div style="margin:6px 0"><select id="beh">${behOptions()}</select>
      <button id="beh-assign" class="mini">assign</button><span id="err"></span></div>
    <h2 style="margin:9px 0 5px">skill</h2>
    ${e.skill.length ? `<table>${e.skill.map(([k, v]) => {
        const [st, sg] = k.split(' '), n = sg === '+' ? 1 : -1;
        return `<tr><td class="k">${sgTok(n)} <span style="color:${COL[st] || COL.dim}">${STATSYM[st] || ''} ${st}</span></td>
                    <td>${bar(v, 5, STATC[st] || '--hp')}${v.toFixed(2)}×</td></tr>`;
      }).join('')}</table>`
      : '<span class="empty">none practised</span>'}
    <h2 style="margin:9px 0 5px">acts</h2>
    <div>${Object.keys(e.acts).length
      ? Object.entries(e.acts).map(([k, v]) =>
          `<span style="color:${(ACTSYM[k] || [,COL.dim])[1]}">${(ACTSYM[k] || ['·'])[0]} ${k} ${v}</span>`
        ).join(' · ') : '<span class="empty">none</span>'}</div>`;
}

// the acts an entity has performed, named as the log names them
const ACTSYM = {gather:['\u2193', '#4ade80'], harm:['\u2715', '#ef4444'],
                give:['\u271a', '#60a5fa'], move:['\u2192', '#5c6b7d'],
                hold:['\u25e6', '#6b7a8d'], blocked:['\u2298', '#c08a68'],
                graze_hazard:['\u25a4', '#e08d5a']};
const logStat = s => `<span class="s-${s}">${STATSYM[s] || ''}${s}</span>`;

// A hex is one place, not two loose numbers, so it reads as one thing: a chip carrying the
// ⬡ that says "somewhere on the map", a real minus so a negative axis can't be mistaken
// for the separator, and -- in the log -- a click that takes the map there.
const hexTok = (q, r) => {
  const n = v => (v < 0 ? '\u2212' : '') + Math.abs(v);
  return `<span class="hex" data-hex="${q},${r}" title="hex q ${q}, r ${r}">`
       + `<span class="ax">\u2b21</span>${n(q)}<span class="ax">,</span>${n(r)}</span>`;
};
const hex = p => Array.isArray(p) ? hexTok(p[0], p[1]) : String(p);

// An event has no id, and walking the world back re-fetches the log -- so the row that was
// clicked comes back as a different object holding the same event. It is identified by what
// it says, not by which object it is, or the highlight would drop off on every replay.
const evkey = v => JSON.stringify(v);

// the one word the map puts on the actor when a row is opened -- the log's own verb
const VERB = {gather: 'gathers', hazard: 'grazes hazard', harm: 'harms', give: 'gives',
              move: 'moves', blocked: 'blocked', hold: 'holds', wasted: 'wastes turn',
              idle: 'idle', death: 'dies', authored: 'authored'};

function line(v, i) {
  const t = `<span class="t">t${String(v.t).padStart(4)}</span> <span class="id">e${String(v.e).padStart(2,'0')}</span>`;
  const rtag = v.rule !== undefined
    ? ` <span class="rule-tag" title="${[v.cond, v.act].filter(Boolean).join(' · ')}">r${v.rule + 1}</span>` : '';
  let body;
  switch (v.kind) {
    case 'gather':    body = `↓ gather <span class="plus">+</span>${v.got} ${logStat(v.stat)} ${hex(v.target)} (drew ${v.drew} ×${v.skill} skill, d${v.dist}, ${v.left} left, hunger ${v.hunger}, strain ${v.strain})`; break;
    case 'hazard':    body = `▤ HAZARD <span class="minus">−</span>${Math.abs(v.got)} ${logStat(v.stat)} ${hex(v.target)}`; break;
    case 'harm':      body = `✕ harm e${v.victim} <span class="minus">−</span>${v.amount} ${logStat(v.stat)} (d${v.dist})`; break;
    case 'give':      body = `✚ give e${v.to_id} <span class="plus">+</span>${v.landed} ${logStat(v.stat)} (paid ${v.paid}, d${v.dist})`; break;
    case 'move':      body = `→ move ${hex(v.frm)} → ${hex(v.to)} toward ${hex(v.target)}${v.dist ? ` (d${v.dist} to go)` : ''}`; break;
    case 'blocked':   body = `⊘ blocked ${hex(v.frm)} → ${hex(v.to)} — ${v.why}`; break;
    case 'hold':      body = `◦ hold ${hex(v.frm)} (d${v.dist} from ${hex(v.target)}) — ${v.why}`; break;
    case 'wasted':    body = `? wasted — ${v.why}`; break;
    case 'idle':      body = `· idle — ${v.why}`; break;
    case 'authored':  body = `✎ chart authored — ${v.n} nodes`; break;
    case 'death':     body = `† DIED at ${hex(v.at)}, lived ${v.lived}, ${v.archetype}, loot ${v.loot}`; break;
    default:          body = JSON.stringify(v);
  }
  const on = focus && focus.key === evkey(v) ? ' on' : '';
  const when = v.t > S.tick ? ' ahead' : v.t === S.tick ? ' now' : '';
  return `<div class="row ${v.kind}${when}${on}" data-e="${v.e}" data-i="${i}">${t}${rtag} ${body}</div>`;
}

// The log is the run's account of itself and does not shrink when the world is walked back
// into it: the turns after the one being shown are still there, dimmed, because they still
// happened -- you are looking at an earlier moment, not undoing a later one. Stepping back
// keeps the line you clicked under your eye rather than letting the rows above shove it away.
let shown = [], lastTick = null, lastHead = null;
function renderLog() {
  const evs = S.events.filter(v => filt === null || v.e === filt);
  shown = evs.slice().reverse();                   // newest first; the server sets the window
  const log = document.getElementById('log');
  log.innerHTML = shown.map((v, i) => line(v, i)).join('') ||
    '<div class="row empty">nothing yet — press tick</div>';
  const grew = lastHead !== null && S.head > lastHead;   // the run played on: new rows on top
  lastHead = S.head;
  if (grew) log.scrollTop = 0;                     // newest first, so the new turn is the top
  else if (S.tick !== lastTick) {                  // walked back: the shown turn, held in the middle
    const now = log.querySelector('.now') || log.querySelector('.row:not(.ahead)');
    log.scrollTop = now ? Math.max(0, now.offsetTop - (log.clientHeight - now.offsetHeight) / 2)
                        : 0;
  }
  lastTick = S.tick;
}

// ---- replay controls. The world can be put back into any turn it has already played
// (decision 37) -- the server keeps the state, so what comes back is the whole world, not
// the map redrawn from the log. Behind the head of the run, the reading is `12 of 40`.
function renderTime() {
  const behind = S.tick < S.head;
  document.getElementById('stat').innerHTML =
    `tick <b>${S.tick}</b>${behind ? ` <span class="behind">of ${S.head}</span>` : ''}`
    + ` · alive <b>${S.alive}</b>/${S.ents.length} · seed ${S.seed}`;
  document.getElementById('bback').disabled = S.tick <= S.first;
  const sc = document.getElementById('scrub');
  sc.min = S.first; sc.max = S.head; sc.disabled = S.head <= S.first;
  if (document.activeElement !== sc || !scrubbing) sc.value = S.tick;
}

function render() {
  renderTime();
  fit(); draw();
  const a = document.activeElement;
  if (!(a && a.closest && a.closest('#rules'))) renderSel();   // never yank a control mid-edit
  renderLog();
}

async function api(path) { S = await (await fetch(path)).json(); render(); }

// scrubbing: one request in flight at a time and the last tick asked for wins, so dragging
// the timeline stays live instead of queueing a request per pixel. The promise resolves once
// the queue has drained, so a caller can go on to work with the state that landed.
let scrubbing = false, chain = Promise.resolve(), want = null;
function goto(t) {
  want = t;
  chain = chain.then(() => {
    if (want === null) return;                 // a later call already asked for a later tick
    const n = want; want = null;
    return api('/api/goto?t=' + n);
  });
  return chain;
}
const onRecord = t => S && t >= S.first && t <= S.head;
const back = () => { if (S && S.tick > S.first) goto(S.tick - 1); };

document.getElementById('bback').onclick = back;
const scrub = document.getElementById('scrub');
scrub.oninput  = e => { scrubbing = true; goto(+e.target.value); };
scrub.onchange = () => { scrubbing = false; };
document.getElementById('b1').onclick   = () => api('/api/tick?n=1');
document.getElementById('b10').onclick  = () => api('/api/tick?n=10');
document.getElementById('b100').onclick = () => api('/api/tick?n=100');
document.getElementById('breset').onclick = () => {
  sel = selCell = filt = null;
  api('/api/reset?seed=' + encodeURIComponent(document.getElementById('seed').value));
};
document.getElementById('bplay').onclick = ev => {
  if (playing) { clearInterval(playing); playing = null; ev.target.classList.remove('on'); ev.target.textContent = 'play'; }
  else { playing = setInterval(() => api('/api/tick?n=1'), 260); ev.target.classList.add('on'); ev.target.textContent = 'pause'; }
};
document.getElementById('trails').onchange = e => { showTrails = e.target.checked; draw(); };
document.getElementById('acts').onchange   = e => { showActs   = e.target.checked; draw(); };
document.getElementById('bfit').onclick   = () => fitView();
// ---- log drawer: the header toggles it shut, the top edge drags its height
const drawer = document.getElementById('drawer');
const setLogH = h => {
  h = Math.max(80, Math.min(window.innerHeight - 160, h));
  drawer.style.setProperty('--logh', h + 'px');
  localStorage.setItem('logh', h);
};
setLogH(+localStorage.getItem('logh') || 210);
if (localStorage.getItem('logshut') === '1') drawer.classList.add('shut');
document.getElementById('filter').onclick = e => {
  if (filt === null) return;
  e.stopPropagation();                     // the chip clears the filter, it does not shut the drawer
  filt = null; render();
};
document.getElementById('dhead').onclick = () => {
  const shut = drawer.classList.toggle('shut');
  localStorage.setItem('logshut', shut ? '1' : '0');
};
document.getElementById('dgrip').onmousedown = e => {
  e.preventDefault();
  const grip = e.currentTarget, y0 = e.clientY, h0 = drawer.offsetHeight;
  grip.classList.add('on');
  const move = ev => setLogH(h0 - (ev.clientY - y0));
  const up = () => { grip.classList.remove('on');
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
};

// A log row is a moment, not a highlight: clicking one walks the world back into the turn
// that event belongs to (decision 37), so the actor is standing where it stood when it acted
// and the line to the cell it aimed at joins the two places it was really drawn between.
// Before, the row was drawn against whatever tick the world happened to be on, which put the
// mark on a body that had since walked away. A row older than the kept span cannot be
// restored, so it only highlights, as every row used to.
const atTurn = v =>                              // the turn this row is an account of
  (v && v.t !== S.tick && onRecord(v.t)) ? goto(v.t) : Promise.resolve();

async function openEvent(v) {
  await atTurn(v);
  focus = {key: evkey(v), actor: v.e,
           other: v.victim !== undefined ? v.victim
                : v.to_id !== undefined ? v.to_id : null,
           // what the row says each end did or had done to it, in one word apiece
           verb: VERB[v.kind] || v.kind,
           role: v.victim !== undefined ? 'harmed' : v.to_id !== undefined ? 'given to' : '',
           cell: v.target || v.at || null};
  sel = v.e; selCell = null; render();       // selects the actor, leaves the log's filter alone
  const ent = S.ents.find(x => x.id === sel);  // where it stands *in that turn*
  if (ent) reveal(ent.q, ent.r);
}

document.getElementById('log').onclick = async e => {
  const row = e.target.closest('.row'); if (!row || !row.dataset.e) return;
  const v = shown[+row.dataset.i]; if (!v) return;
  const chip = e.target.closest('.hex');       // a coordinate is a link to the hex it names
  if (chip) { await atTurn(v);
    const [q, r] = chip.dataset.hex.split(',').map(Number); goCell(q, r); return; }
  await openEvent(v);
};

// Up and down walk the log the way clicking each row in turn would -- the world follows into
// every row's turn, so holding a key plays the run back event by event. Rows are newest-first,
// so up is the newer event. The walk stays in whatever the log is showing -- reading a row
// selects its actor but does not narrow the log to it, or every step would shut the rest of
// the run out. Keys are queued because each step is a round trip, faster than the server.
let keying = Promise.resolve();
const stepRow = back => { keying = keying.then(() => walkRow(back)); };
async function walkRow(back) {
  if (!shown.length) return;
  const i = focus ? shown.findIndex(v => evkey(v) === focus.key) : -1;
  const j = i < 0 ? 0 : Math.min(shown.length - 1, Math.max(0, i + (back ? -1 : 1)));
  await openEvent(shown[j]);
  const el = document.querySelector('#log .row.on');   // the render replaced every row
  if (el) el.scrollIntoView({block: 'nearest'});
}
cv.onclick = e => {
  if (dragged) { dragged = false; return; }   // a pan, not a select
  const b = cv.getBoundingClientRect();
  const [q, r] = pixelToHex(e.clientX - b.left, e.clientY - b.top);
  const hit = S.ents.find(x => x.alive && x.q === q && x.r === r);
  focus = null;
  if (hit) { sel = filt = hit.id; selCell = null; } else { sel = filt = null; selCell = [q, r]; }
  render();
  reveal(q, r);      // the card just opened over the map: slide the pick out from under it
};

// ---- camera: wheel zooms about the cursor, drag pans, double-click fits
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const b = cv.getBoundingClientRect();
  const mx = e.clientX - b.left, my = e.clientY - b.top;
  const [cx, cy] = centre();
  const k0 = scale();
  const wx = (mx - cx - panX) / k0, wy = (my - cy - panY) / k0;     // world pt under cursor
  zoom = Math.max(0.2, Math.min(8, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  const k1 = scale();
  panX = mx - cx - wx * k1; panY = my - cy - wy * k1;               // keep it pinned
  draw();
}, {passive: false});
cv.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  drag = {x: e.clientX, y: e.clientY, panX, panY};
  dragged = false;
});
window.addEventListener('mousemove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!dragged && Math.hypot(dx, dy) > 3) dragged = true;
  if (dragged) { panX = drag.panX + dx; panY = drag.panY + dy; draw(); }
});
window.addEventListener('mouseup', () => { drag = null; });
const fitView = () => { zoom = 1; panX = panY = 0; fit(); draw(); };
cv.ondblclick = fitView;

// the box is the source of truth for size: follow it, and the window for DPR changes
new ResizeObserver(() => { fit(); draw(); }).observe(cv);
window.addEventListener('resize', () => { fit(); draw(); });

// ---- keyboard: arrows walk the cursor over the cells, ctrl+arrows walk the entity ids
// up/down have two hexes to choose from, so they alternate by row parity: the cursor
// zigzags about one column instead of sliding off diagonally, and up/down undo each other
const STEP = {
  ArrowLeft:  (q, r) => [q - 1, r],
  ArrowRight: (q, r) => [q + 1, r],
  ArrowUp:    (q, r) => [(r & 1) ? q + 1 : q, r - 1],
  ArrowDown:  (q, r) => [(r & 1) ? q : q - 1, r + 1],
};
const onMap = (q, r) => S && Math.abs(q) <= S.radius && Math.abs(r) <= S.radius
                          && Math.abs(q + r) <= S.radius;

// what the map can actually be seen through: the canvas inset by a hex of edge, minus the
// strip the inspector card floats over -- a cell behind the card is on screen but not in
// sight. If dodging the card would leave no room worth panning into, the canvas is used whole.
function sightBox() {
  const m = SIZE * scale(), insp = document.getElementById('insp');
  const box = {l: m, t: m, r: view.w - m, b: view.h - m};
  if (!insp.hidden) {
    const edge = insp.getBoundingClientRect().left - cv.getBoundingClientRect().left - 6;
    if (edge - box.l > 2 * m) box.r = Math.min(box.r, edge);
  }
  return box;
}

// slide the camera the least it can so the cell sits inside that box: a cell already in
// sight doesn't move the field at all, and one behind the card slides just clear of it
function keepInView(q, r) {
  const [cx, cy] = centre(), k = scale(), [wx, wy] = px(q, r), b = sightBox();
  const sx = cx + panX + wx * k, sy = cy + panY + wy * k, x0 = panX, y0 = panY;
  if (sx < b.l) panX += b.l - sx; else if (sx > b.r) panX -= sx - b.r;
  if (sy < b.t) panY += b.t - sy; else if (sy > b.b) panY -= sy - b.b;
  return panX !== x0 || panY !== y0;
}

// the card is only there once the selection has been drawn, so room for it can only be made
// after that render -- hence reveal-after-render rather than keepInView-before
const reveal = (q, r) => { if (keepInView(q, r)) draw(); };

// land on a cell the way a click on it would: an entity standing there is the thing you
// picked, bare ground is a cell pick
function goCell(q, r) {
  const hit = S.ents.find(x => x.alive && x.q === q && x.r === r);
  focus = null;
  if (hit) { sel = filt = hit.id; selCell = null; } else { sel = filt = null; selCell = [q, r]; }
  render();
  reveal(q, r);
}

function moveCursor(key) {
  if (!S) return;
  const held = sel !== null ? S.ents.find(x => x.id === sel) : null;
  const cur = selCell ? selCell : held ? [held.q, held.r] : null;
  if (!cur) { goCell(0, 0); return; }        // nothing held yet: start at the middle
  const [q, r] = STEP[key](cur[0], cur[1]);
  if (onMap(q, r)) goCell(q, r);             // the rim stops the cursor, it doesn't wrap
}

// ctrl+arrows read the roster, not the map: the next or previous id, wrapping round
function stepEntity(back) {
  if (!S) return;
  const live = S.ents.filter(x => x.alive).sort((a, b) => a.id - b.id);
  if (!live.length) return;
  const i = sel === null ? -1 : live.findIndex(x => x.id === sel);
  const j = i < 0 ? (back ? live.length - 1 : 0)
                  : (i + (back ? -1 : 1) + live.length) % live.length;
  const e = live[j];
  sel = filt = e.id; selCell = null; focus = null;
  render();
  reveal(e.q, e.r);
}

document.onkeydown = e => {
  const a = e.target;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'
            || a.isContentEditable)) return;
  if (e.key === ' ' || e.key === '.') { e.preventDefault(); api('/api/tick?n=1'); }
  if (e.key === ',') { e.preventDefault(); back(); }   // step back a turn, the whole world with it
  if (e.key === 'Escape') { sel = selCell = filt = null; focus = null; render(); }
  if (a && a.closest && a.closest('#log') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); stepRow(e.key === 'ArrowUp'); return;
  }
  if (STEP[e.key] && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (e.ctrlKey) stepEntity(e.key === 'ArrowLeft' || e.key === 'ArrowUp');
    else moveCursor(e.key);
  }
};
loadBehaviours();
api('/api/state');
