const SIZE = 17, SQ3 = Math.sqrt(3);
const STATC = {hp:'--hp', speed:'--speed', sense:'--sense', rules:'--rules'};
// decision 24: one code across map, rule text and log. Hue names the stat, the +/- glyph
// names the direction -- the same (stat, sign) pair that types actions and keys skill.
const STATSYM = {hp:'\u2665', speed:'\u00bb', sense:'\u25c9', rules:'\u2261',
                 position:'\u2192'};   // movement: the sign says toward or away
const ARCH    = {gatherer:'#4ade80', raider:'#ef4444', giver:'#60a5fa',
                 wanderer:'#94a3b8', inert:'#5b6675'};
const ARCHSYM = {gatherer:'\u25cf', raider:'\u25b2', giver:'\u25c6',
                 wanderer:'\u25a0', inert:'\u25cb'};
// an outcome that delivered nothing still says something: mark it on the actor
const MARK = {wasted:['?', '#c9a24a'], blocked:['\u2298', '#c08a68'],
              idle:['\u00b7', '#5a6473'], hold:['\u25e6', '#5a6473'],
              slot_lost:['\u2261', '#f472b6']};
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
let S = null, sel = null, selCell = null, playing = null, showTrails = false, showActs = true;
let zoom = 1, panX = 0, panY = 0, drag = null, dragged = false;
let focus = null;   // the event a log row points at: actor, counterparty, target cell

const cssvar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = {position:'#8fa3bb'};
for (const k in STATC) COL[k] = cssvar(STATC[k]);
for (const k of ['bad', 'give', 'dim', 'focus']) COL[k] = cssvar('--' + k);
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
// a glyph on a tinted cell has to beat its own hue, so labels use a lightened stat colour
const lighten = (hex, t) => {
  const n = parseInt(hex.slice(1), 16), m = v => Math.round(v + (255 - v) * t);
  return `rgb(${m(n >> 16 & 255)},${m(n >> 8 & 255)},${m(n & 255)})`;
};
const LIT = {};
for (const k in COL) if (COL[k][0] === '#') LIT[k] = lighten(COL[k], .5);
const px = (q, r) => [SIZE * SQ3 * (q + r / 2), SIZE * 1.5 * r];

function fit() {
  const R = S.radius;
  cv.width  = SIZE * SQ3 * (2 * R + 2) + 20;
  cv.height = SIZE * 1.5 * (2 * R + 2) + 20;
}
const centre = () => [cv.width / 2, cv.height / 2];

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
  const x = (mx - cx - panX) / zoom, y = (my - cy - panY) / zoom;
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

// what the ground does: hue is the stat it moves, the glyph the direction, the fill height
// how much is left, and hatching that it takes rather than gives (decision 11)
function drawCell(cx, cy, c) {
  const [dx, dy] = px(c.q, c.r), X = cx + dx, Y = cy + dy, s = SIZE - 1;
  const frac = Math.min(1, c.amount / Math.max(1, c.cap));
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

// the tick's actions, drawn as what they are: a line from actor to the cell it aimed at,
// coloured by the (stat, sign) it delivered
function drawAct(cx, cy, e, v) {
  const [ex, ey] = px(e.q, e.r), X = cx + ex, Y = cy + ey;
  ctx.strokeStyle = actHue(v); ctx.lineWidth = 1.5; ctx.globalAlpha = .8;
  if (v.kind === 'move') {
    const [fx, fy] = px(v.frm[0], v.frm[1]);
    ctx.beginPath(); ctx.moveTo(cx + fx, cy + fy); ctx.lineTo(X, Y); ctx.stroke();
    ctx.globalAlpha = 1;
    mark(X, Y - 11, '\u2193', '#93a4b8', 9);
    return;
  }
  if (!v.target) { ctx.globalAlpha = 1; return; }
  const [tx, ty] = px(v.target[0], v.target[1]), TX = cx + tx, TY = cy + ty;
  ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(TX, TY);
  ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (v.kind === 'harm' || v.kind === 'give')       // landed on a body: show what it moved
    glyph(TX, TY, v.kind === 'give' ? 1 : -1, STATSYM[v.stat] || '?',
          LIT[v.stat] || LIT.hp, 11, true);
  else {                                            // drawn from the ground into the actor
    ctx.beginPath(); ctx.arc(X, Y, 2.5, 0, 7);
    ctx.fillStyle = v.kind === 'hazard' ? COL.bad : (COL[v.stat] || COL.hp); ctx.fill();
  }
}

function draw() {
  if (!S) return;
  const [cx, cy] = centre();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  // camera: scale world coords (which are centre + hex offset) around the centre, then pan
  ctx.setTransform(zoom, 0, 0, zoom, cx * (1 - zoom) + panX, cy * (1 - zoom) + panY);

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

  // this tick's actions, under the bodies that made them -- several per entity now
  // that speed is an action budget (decision 30)
  const acts = {};
  for (const v of S.events) if (v.t === S.tick) (acts[v.e] || (acts[v.e] = [])).push(v);
  if (showActs)
    for (const e of S.ents) if (e.alive && acts[e.id])
      for (const v of acts[e.id]) drawAct(cx, cy, e, v);

  // entities
  for (const e of S.ents) {
    if (!e.alive) continue;
    const [x, y] = px(e.q, e.r), X = cx + x, Y = cy + y;
    const hp = Math.max(0, Math.min(1, e.stat.hp / 20));
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
    const at = id => { const e = S.ents.find(e => e.id === id); return e ? px(e.q, e.r) : null; };
    const a = at(focus.actor);
    const tgt = focus.cell ? px(focus.cell[0], focus.cell[1]) : null;
    if (a && tgt) {                                   // the reach of the action
      ctx.beginPath(); ctx.moveTo(cx + a[0], cy + a[1]); ctx.lineTo(cx + tgt[0], cy + tgt[1]);
      ctx.strokeStyle = COL.focus; ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (tgt) {                                        // the cell it landed on
      hexPath(cx + tgt[0], cy + tgt[1], SIZE - 1);
      ctx.strokeStyle = COL.focus; ctx.lineWidth = 2; ctx.stroke();
    }
    const o = focus.other !== null ? at(focus.other) : null;
    if (o) {                                          // the other party
      ctx.beginPath(); ctx.arc(cx + o[0], cy + o[1], 11, 0, 7);
      ctx.strokeStyle = COL.focus; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = COL.focus; ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'center'; ctx.fillText('e' + focus.other, cx + o[0], cy + o[1] - 14);
    }
  }
  if (selCell) {
    const [x, y] = px(selCell[0], selCell[1]);
    hexPath(cx + x, cy + y, SIZE - 1);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

// ---- conditions/actions read back in the map's own symbols. Built from the chart nodes
// themselves, so the description cannot drift from what the sim runs. Symbol-only: hue
// names the stat, a sign glyph names the direction.
const stSym  = s => `<span class="s-${s}">${STATSYM[s] || ''}</span>`;
const stTok  = s => `<span class="s-${s}">${STATSYM[s] || ''} ${s}</span>`;
const sgTok  = n => n > 0 ? '<span class="plus">+</span>' : '<span class="minus">\u2212</span>';
const numTok = v => typeof v === 'string'
  ? `<span class="num expr">${v}</span>`
  : `<span class="num">${v}</span>`;
const opTok  = o => `<span class="op">${({'<':'&lt;','>':'&gt;','<=':'&le;','>=':'&ge;'})[o] || o}</span>`;
const kw     = t => `<span class="kw">${t}</span>`;

// a selector in symbols: ↩ it, ● nearest entity, ⬡ + sign + stat = nearest source
function selSym(sl) {
  if (sl[0] === 'it')     return kw('\u21a9');
  if (sl[0] === 'entity') return kw('\u25cf');
  return `${kw('\u2b21')}${sgTok(sl[2])}${stSym(sl[1])}`;
}

function condSym(c) {
  switch (c[0]) {
    case 'always':       return kw('\u22c6');
    case 'self':         return `${stSym(c[1])} ${opTok(c[2])} ${numTok(c[3])}`;
    case 'other':        return `${kw('\u25cf')}${stSym(c[1])} ${opTok(c[2])} ${numTok(c[3])}`;
    case 'dist_entity':  return `${kw('\u2921\u25cf')} ${opTok(c[1])} ${numTok(c[2])}`;
    case 'dist_source':  return `${kw('\u2921')}${selSym(['source', c[1], c[2]])} ${opTok(c[3])} ${numTok(c[4])}`;
    case 'count_entity': return `${kw('#\u25cf')} ${opTok(c[1])} ${numTok(c[2])}`;
    case 'amount':       return `${kw('\u25a4')}${selSym(['source', c[1], c[2]])} ${opTok(c[3])} ${numTok(c[4])}`;
  }
  return kw(String(c));
}

const condsSym = cs => cs.map(condSym).join(` ${kw('\u2227')} `);

// the verb is read off (selector kind, sign) -- the same pair the sim resolves, named after
// the fact (decision 3)
function actSym(a) {
  if (a[0] === 'move')
    return `<span class="mv">${a[2] > 0 ? '\u2192' : '\u2190'}</span>${selSym(a[1])}`;
  const sl = a[1];
  if (sl[0] === 'source') {                        // the source carries its own (stat, sign)
    return sl[2] > 0
      ? `<span class="plus">\u2193</span>${selSym(sl)}`
      : `<span class="minus">\u2191</span>${selSym(sl)}`;
  }
  const stat = a[2], sign = a[3];
  if (sl[0] === 'entity') return sign > 0
    ? `<span class="plus">\u271a</span>${stSym(stat)}${selSym(sl)}`
    : `<span class="minus">\u2715</span>${stSym(stat)}${selSym(sl)}`;
  return `${sgTok(sign)}${stSym(stat)}${selSym(sl)}`;
}

// ---- flow-chart viewer (decision 26). The inspector shows the selected entity's chart
// read-only; authoring happens in /flowchart. A chart can chain actions, so one tick runs
// several -- the budget is the entity's speed, one action per point.
const CHGLYPH = { start: '\u25b8', decision: '\u25c6', action: '\u25a1', end: '\u25a0' };
function chartHTML(chart) {
  if (!chart || !chart.nodes) return '<span class="empty">no chart</span>';
  return Object.keys(chart.nodes).map(id => {
    const n = chart.nodes[id];
    let body;
    if (n.type === 'start') body = `${kw('start')} \u2192 ${n.next || '\u2014'}`;
    else if (n.type === 'end') body = kw('end');
    else if (n.type === 'decision') body = `if ${condsSym(n.conds)}`
      + `<br>&nbsp; <span class="kw">yes</span> ${n.yes || '\u2014'}`
      + ` &middot; <span class="kw">no</span> ${n.no || '\u2014'}`;
    else if (n.type === 'action') body = `${actSym(n.act)} \u2192 ${n.next || '\u2014'}`;
    else body = kw(String(n.type));
    return `<div class="hd"><span class="ord">${CHGLYPH[n.type] || '?'}</span>`
      + `<span class="says">${body}</span></div>`;
  }).join('');
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

const selBox = document.getElementById('sel');
selBox.addEventListener('click', ev => {
  if (ev.target.id === 'beh-assign') {
    const name = document.getElementById('beh').value;
    const graph = name && BEHAVIOURS[name];
    if (graph) assignChart(graph);
  }
});

function bar(v, max, col) {
  const w = Math.max(1, Math.round(52 * Math.min(1, v / max)));
  return `<span class="bar" style="width:${w}px;background:${cssvar(col)}"></span>`;
}

function renderSel() {
  const box = document.getElementById('sel');
  document.getElementById('filter').textContent = sel !== null ? `· e${sel}` : '';
  if (sel === null) {
    if (selCell) {
      const c = S.cells.find(c => c.q === selCell[0] && c.r === selCell[1]);
      box.innerHTML = c
        ? `<b>cell ${c.q},${c.r}</b> ${sgTok(c.delta)}${stTok(c.stat)}
           <span class="kw">${c.delta < 0 ? '▤ takes' : '↓ gives'} ${Math.abs(c.delta)} a draw</span>
           <table><tr><td class="k">amount</td><td>${c.amount} / ${c.cap}
             <span class="kw">${'█'.repeat(Math.round(8*Math.min(1,c.amount/Math.max(1,c.cap))))}</span></td></tr>
           <tr><td class="k">origin</td><td>${c.wild ? 'wild' : 'corpse loot'}</td></tr></table>`
        : `<b>cell ${selCell[0]},${selCell[1]}</b> <span class="empty">empty ground</span>`;
      return;
    }
    box.innerHTML = '<span class="empty">click an entity or a cell</span>';
    return;
  }
  const e = S.ents.find(e => e.id === sel);
  if (!e) { box.innerHTML = '<span class="empty">gone</span>'; return; }
  box.innerHTML = `
    <div style="margin-bottom:6px">
      <b>e${e.id}</b> · <span title="spawned as">${e.arch}</span> · ${e.archetype} · ${e.q},${e.r}
      ${focus && focus.other !== null ? `<span style="color:var(--speed)">↔ e${focus.other}</span>` : ''}
      ${e.alive ? '' : `<span class="death">DEAD t${e.died}</span>`}
    </div>
    <table>
      <tr><td class="k">strain</td><td>${bar(e.strain, 25, '--bad')}${e.strain}
          <span style="color:var(--dim)">unpaid upkeep</span></td></tr>
      <tr><td class="k">condition</td><td>${bar(e.condition, 1, '--speed')}${(e.condition*100).toFixed(0)}%
          <span style="color:var(--dim)">of full effect</span></td></tr>
    </table>
    <table>${Object.entries(e.stat).map(([k, v]) =>
      `<tr><td class="k" style="color:${COL[k]}">${STATSYM[k]} ${k}</td>
           <td>${bar(v, k==='hp'?20:k==='sense'?6:5, STATC[k])}${v}</td></tr>`).join('')}</table>
    <h2 style="margin:9px 0 5px">behaviour
      <span style="text-transform:none;letter-spacing:0;font-weight:400">· one action per speed point</span></h2>
    <div class="chart">${chartHTML(e.chart)}</div>
    <div style="margin:6px 0"><select id="beh">${behOptions()}</select>
      <button id="beh-assign" class="mini">assign</button><span id="err"></span></div>
    <h2 style="margin:9px 0 5px">skill</h2>
    ${e.skill.length ? `<table>${e.skill.map(([k, v]) => {
        const [st, sg] = k.split(' '), n = sg === '+' ? 1 : -1;
        return `<tr><td class="k">${sgTok(n)} <span style="color:${COL[st] || COL.dim}">${STATSYM[st] || ''} ${st}</span></td>
                    <td>${bar(v, 5, st === 'position' ? '--dim' : (STATC[st] || '--hp'))}${v.toFixed(2)}×</td></tr>`;
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

function line(v, i) {
  const t = `<span class="t">t${String(v.t).padStart(4)}</span> <span class="id">e${String(v.e).padStart(2,'0')}</span>`;
  const rtag = v.rule !== undefined
    ? ` <span class="rule-tag" title="${[v.cond, v.act].filter(Boolean).join(' · ')}">r${v.rule + 1}</span>` : '';
  let body;
  switch (v.kind) {
    case 'gather':    body = `↓ gather <span class="plus">+</span>${v.got} ${logStat(v.stat)} @${v.target} (drew ${v.drew}, d${v.dist}, ${v.left} left, strain ${v.strain})`; break;
    case 'hazard':    body = `▤ HAZARD <span class="minus">−</span>${Math.abs(v.got)} ${logStat(v.stat)} @${v.target}`; break;
    case 'harm':      body = `✕ harm e${v.victim} <span class="minus">−</span>${v.amount} ${logStat(v.stat)} (d${v.dist})`; break;
    case 'give':      body = `✚ give e${v.to_id} <span class="plus">+</span>${v.landed} ${logStat(v.stat)} (paid ${v.paid}, d${v.dist})`; break;
    case 'move':      body = `→ move ${v.frm}→${v.to} (${v.steps}${v.wanted > v.steps ? '/' + v.wanted + ', short' : ''}) toward ${v.target}`; break;
    case 'blocked':   body = `⊘ blocked ${v.frm}→${v.to} — ${v.why}`; break;
    case 'hold':      body = `◦ hold ${v.frm} (d${v.dist} from ${v.target}) — ${v.why}`; break;
    case 'wasted':    body = `? wasted — ${v.why}`; break;
    case 'idle':      body = `· idle — ${v.why}`; break;
    case 'slot_lost': body = `≡ slot lost → ${v.slots} rules`; break;
    case 'authored':  body = `✎ chart authored — ${v.n} nodes`; break;
    case 'death':     body = `† DIED at ${v.at}, lived ${v.lived}, ${v.archetype}, loot ${v.loot}`; break;
    default:          body = JSON.stringify(v);
  }
  const on = focus && focus.ev === v ? ' style="background:#1e2937"' : '';
  return `<div class="row ${v.kind}" data-e="${v.e}" data-i="${i}"${on}>${t}${rtag} ${body}</div>`;
}

let shown = [];
function renderLog() {
  const evs = S.events.filter(v => sel === null || v.e === sel);
  shown = evs.slice(-500).reverse();
  document.getElementById('log').innerHTML =
    shown.map((v, i) => line(v, i)).join('') ||
    '<div class="row empty">nothing yet — press tick</div>';
}

function render() {
  document.getElementById('stat').innerHTML =
    `tick <b>${S.tick}</b> · alive <b>${S.alive}</b>/${S.ents.length} · seed ${S.seed}`;
  fit(); draw();
  const a = document.activeElement;
  if (!(a && a.closest && a.closest('#rules'))) renderSel();   // never yank a control mid-edit
  renderLog();
}

function drawKey() {
  const st = k => `<span class="s-${k}">${STATSYM[k]} ${k}</span>`;
  const ar = a => `<span style="color:${ARCH[a]}">${ARCHSYM[a]} ${a}</span>`;
  document.getElementById('key').innerHTML = `
    <div class="r"><b>stats</b>${['hp','speed','sense','rules'].map(st).join('')}
      <span class="kw">hue names the stat, + / − the direction</span></div>
    <div class="r"><b>ground</b>
      <span><span class="plus">+</span><span class="s-hp">♥</span> source
        <span class="kw">— fill height is what is left</span></span>
      <span><span class="minus">−</span><span class="s-hp">♥</span>
        <span class="minus">hatched = hazard</span></span>
      <span class="kw">dashed inner ring = corpse loot</span></div>
    <div class="r"><b>bodies</b>${['gatherer','raider','giver','wanderer','inert'].map(ar).join('')}
      <span class="kw">size = hp</span>
      <span class="minus">◌ ring = strain</span></div>
    <div class="r"><b>this tick</b>
      <span class="move">→ move</span><span class="gather">↓ gather</span>
      <span class="harm">✕ strike</span><span class="give">✚ give</span>
      <span class="wasted">? wasted</span><span class="blocked">⊘ blocked</span>
      <span class="idle">· idle</span>
      <span class="kw">— the line runs actor → target cell</span></div>
    <div class="r"><b>view</b><span class="kw">wheel = zoom · drag = pan · double-click = fit</span></div>`;
}

async function api(path) { S = await (await fetch(path)).json(); render(); }

document.getElementById('b1').onclick   = () => api('/api/tick?n=1');
document.getElementById('b10').onclick  = () => api('/api/tick?n=10');
document.getElementById('b100').onclick = () => api('/api/tick?n=100');
document.getElementById('breset').onclick = () => {
  sel = selCell = null;
  api('/api/reset?seed=' + encodeURIComponent(document.getElementById('seed').value));
};
document.getElementById('bplay').onclick = ev => {
  if (playing) { clearInterval(playing); playing = null; ev.target.classList.remove('on'); ev.target.textContent = 'play'; }
  else { playing = setInterval(() => api('/api/tick?n=1'), 260); ev.target.classList.add('on'); ev.target.textContent = 'pause'; }
};
document.getElementById('trails').onchange = e => { showTrails = e.target.checked; draw(); };
document.getElementById('acts').onchange   = e => { showActs   = e.target.checked; draw(); };
document.getElementById('bfit').onclick   = () => fitView();
document.getElementById('log').onclick = e => {
  const row = e.target.closest('.row'); if (!row || !row.dataset.e) return;
  const v = shown[+row.dataset.i];
  focus = v ? {ev: v, actor: v.e,
               other: v.victim !== undefined ? v.victim
                    : v.to_id !== undefined ? v.to_id : null,
               cell: v.target || v.at || null} : null;
  sel = +row.dataset.e; selCell = null; render();
};
cv.onclick = e => {
  if (dragged) { dragged = false; return; }   // a pan, not a select
  const b = cv.getBoundingClientRect();
  const [q, r] = pixelToHex(e.clientX - b.left, e.clientY - b.top);
  const hit = S.ents.find(x => x.alive && x.q === q && x.r === r);
  focus = null;
  if (hit) { sel = hit.id; selCell = null; } else { sel = null; selCell = [q, r]; }
  render();
};

// ---- camera: wheel zooms about the cursor, drag pans, double-click fits
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const b = cv.getBoundingClientRect();
  const mx = e.clientX - b.left, my = e.clientY - b.top;
  const [cx, cy] = centre();
  const wx = (mx - cx - panX) / zoom, wy = (my - cy - panY) / zoom;  // world pt under cursor
  zoom = Math.max(0.2, Math.min(8, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  panX = mx - cx - wx * zoom; panY = my - cy - wy * zoom;           // keep it pinned
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
const fitView = () => { zoom = 1; panX = panY = 0; draw(); };
cv.ondblclick = fitView;

document.onkeydown = e => {
  if (e.key === ' ') { e.preventDefault(); api('/api/tick?n=1'); }
  if (e.key === 'Escape') { sel = selCell = null; focus = null; render(); }
};
drawKey();
loadBehaviours();
api('/api/state');
