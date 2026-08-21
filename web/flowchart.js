/* Flowchart editor for authoring character behaviour.
 *
 * A behaviour is a small directed graph of four node kinds:
 *
 *     start     entry point — one outgoing `next` edge
 *     decision  a list of AND'd conditions — `yes` / `no` edges
 *     action    a single action — one `next` edge
 *     end       terminal — nothing further this tick
 *
 * Each tick the sim begins at `start` and follows edges until it reaches an
 * `end`, evaluating decisions and carrying out every action on the way. This
 * generalises the old ordered rule list (a list is a linear chain of
 * decisions with a fall-through) and adds real branching and merging.
 *
 * The condition/action vocabulary is the same one the sim understands
 * (self/other/dist/amount/count tests; move/act verbs; entity/source/it
 * selectors). The editor is generated from that grammar, so no state the UI
 * can reach is an illegal node.
 *
 * This file is the editor only: it turns a graph object into DOM + SVG and
 * back. Node positions are editor state held apart from the graph, so the
 * exported JSON stays purely semantic. Depends on nothing else.
 *
 *   new Flowchart(container, { graph, onChange })
 *     .getGraph()   -> the graph object (deep copy)
 *     .setGraph(g)  -> replace and re-render
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------- grammar
  const STATS = ['hp', 'speed', 'sense', 'rules'];
  const OPS = ['<', '>', '<=', '>='];
  const STATSYM = { hp: '\u2665', speed: '\u00bb', sense: '\u25c9', rules: '\u2261',
                    position: '\u2192' };
  const GLYPH = { start: '\u25b8', decision: '\u25c6', action: '\u25a1', end: '\u25a0' };
  const LIB_KEY = 'substrate.flowchart.library';
  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const COND_SPEC = {
    always: [], self: ['stat', 'op', 'num'], other: ['stat', 'op', 'num'],
    dist_entity: ['op', 'num'], dist_source: ['stat', 'sign', 'op', 'num'],
    count_entity: ['op', 'num'], amount: ['stat', 'sign', 'op', 'num'],
  };
  const ACT_SPEC = { move: ['sel', 'sign'], act: ['sel', 'stat', 'sign'] };
  const SEL_SPEC = { entity: [], source: ['stat', 'sign'], it: [] };
  const GRAMMAR = { cond: COND_SPEC, act: ACT_SPEC, sel: SEL_SPEC };

  const FDEF = { stat: () => 'hp', op: () => '<', sign: () => 1, num: () => 3,
                 sel: () => ['source', 'hp', 1] };

  const defaultFor = (spec, kind) => {
    const fields = GRAMMAR[spec][kind] || [];
    const v = [kind, ...fields.map(t => FDEF[t]())];
    // an act on a source names no stat/sign: the source carries them
    if (spec === 'act' && kind === 'act' && v[1][0] === 'source') return [kind, v[1]];
    return v;
  };
  const actWith = sel => sel[0] === 'source' ? ['act', sel]
    : ['act', sel, FDEF.stat(), FDEF.sign()];

  // ---------------------------------------------------------------- readable forms
  const sym = s => `<span class="s-${s}">${STATSYM[s] || ''}${s}</span>`;
  const sgTok = n => n > 0 ? '<span class="plus">+</span>' : '<span class="minus">\u2212</span>';
  const opTok = o => `<span class="op">${({'<': '&lt;', '>': '&gt;', '<=': '&le;', '>=': '&ge;'})[o] || o}</span>`;
  const kw = t => `<span class="kw">${t}</span>`;
  const numTok = v => typeof v === 'string'
    ? `<span class="num expr">${esc(v)}</span>`
    : `<span class="num">${v}</span>`;

  function selHTML(sl) {
    if (sl[0] === 'it') return kw('it');
    if (sl[0] === 'entity') return kw('nearest entity');
    return `${kw('nearest')} ${sgTok(sl[2])}${sym(sl[1])} ${kw('source')}`;
  }
  function condHTML(c) {
    switch (c[0]) {
      case 'always':       return kw('always');
      case 'self':         return `${sym(c[1])} ${opTok(c[2])} ${numTok(c[3])}`;
      case 'other':        return `${kw('nearest')} ${sym(c[1])} ${opTok(c[2])} ${numTok(c[3])}`;
      case 'dist_entity':  return `${kw('dist')}(${kw('nearest entity')}) ${opTok(c[1])} ${numTok(c[2])}`;
      case 'dist_source':  return `${kw('dist')}(${selHTML(['source', c[1], c[2]])}) ${opTok(c[3])} ${numTok(c[4])}`;
      case 'count_entity': return `${kw('count')}(${kw('entities')}) ${opTok(c[1])} ${numTok(c[2])}`;
      case 'amount':       return `${kw('amount')}(${selHTML(['source', c[1], c[2]])}) ${opTok(c[3])} ${numTok(c[4])}`;
    }
    return kw(String(c));
  }
  function actHTML(a) {
    if (a[0] === 'move') return `${kw('move')} ${a[2] > 0 ? kw('toward') : kw('away from')} ${selHTML(a[1])}`;
    const sl = a[1];
    if (sl[0] === 'source') return `${kw('act on')} ${selHTML(sl)}`;
    return `${kw('act')} ${sgTok(a[3])}${sym(a[2])} ${kw('on')} ${selHTML(sl)}`;
  }

  // ---------------------------------------------------------------- field editors
  const opt = (list, v, lab) => list.map(x =>
    `<option value="${x}"${String(x) === String(v) ? ' selected' : ''}>${lab ? lab(x) : x}</option>`
  ).join('');

  function fieldHTML(t, v) {
    if (t === 'sel')  return nodeEditor('sel', v);
    if (t === 'stat') return `<select class="fc-f" data-t="stat">${opt(STATS, v)}</select>`;
    if (t === 'op')   return `<select class="fc-f" data-t="op">${opt(OPS, v)}</select>`;
    if (t === 'num')  return `<input class="fc-f" data-t="num" value="${v}" title="a number, or an expression over your stats e.g. u.sense/2">`;
    if (t === 'sign') return `<select class="fc-f" data-t="sign">${opt([1, -1], v, s => s > 0 ? '+' : '\u2212')}</select>`;
    return '';
  }

  function nodeEditor(spec, v) {
    const kind = v[0];
    let fields = GRAMMAR[spec][kind] || [];
    if (spec === 'act' && kind === 'act' && v[1][0] === 'source')
      fields = fields.filter(t => t !== 'stat' && t !== 'sign');   // source carries its own
    return `<span class="fc-node-editor fc-f" data-spec="${spec}">`
         + `<select class="fc-kind">${opt(Object.keys(GRAMMAR[spec]), kind)}</select>`
         + fields.map((t, i) => fieldHTML(t, v[i + 1])).join('')
         + `</span>`;
  }

  const numVal = s => {
    s = String(s).trim();
    if (s === '') return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  };

  function readEditor(box) {
    const out = [box.querySelector(':scope > select.fc-kind').value];
    for (const el of box.querySelectorAll(':scope > .fc-f')) {
      if (el.classList.contains('fc-node-editor')) out.push(readEditor(el));
      else if (el.dataset.t === 'num') out.push(numVal(el.value));
      else if (el.dataset.t === 'sign')
        out.push(Number.isFinite(+el.value) ? +el.value : 0);
      else out.push(el.value);
    }
    return out;
  }

  // ---------------------------------------------------------------- graph model
  const targets = n => n.type === 'decision' ? [n.yes, n.no]
    : (n.type === 'end' ? [] : [n.next]);

  function sampleGraph() {
    return {
      nodes: {
        n1: { type: 'start', next: 'n2' },
        n2: { type: 'decision', conds: [['self', 'hp', '<', 8]], yes: 'n3', no: 'n5' },
        n3: { type: 'action', act: ['move', ['entity'], -1], next: 'n4' },
        n4: { type: 'end' },
        n5: { type: 'decision', conds: [['amount', 'hp', 1, '>', 0]], yes: 'n6', no: 'n7' },
        n6: { type: 'action', act: ['act', ['source', 'hp', 1]], next: 'n4' },
        n7: { type: 'action', act: ['move', ['source', 'hp', 1], 1], next: 'n4' },
      },
    };
  }

  // ---------------------------------------------------------------- layout
  // Auto-layout in local space (centred on the origin). Height- and width-aware:
  // each layer's top is pushed down by the tallest node above it, and nodes in a
  // layer are spaced by their real widths, so nothing ever overlaps.
  function layout(g, rect) {
    const ids = Object.keys(g.nodes);
    const startId = ids.find(id => g.nodes[id].type === 'start');
    const layer = {};
    if (startId) layer[startId] = 0;
    for (let i = 0; i <= ids.length + 1; i++) {
      let ch = false;
      for (const id of ids) {
        if (layer[id] === undefined) continue;
        for (const t of targets(g.nodes[id])) {
          if (t != null && g.nodes[t] && (layer[t] === undefined || layer[t] < layer[id] + 1)) {
            layer[t] = layer[id] + 1; ch = true;
          }
        }
      }
      if (!ch) break;
    }
    const reachable = ids.filter(id => layer[id] !== undefined);
    const orphans = ids.filter(id => layer[id] === undefined);
    const byLayer = {};
    for (const id of reachable) (byLayer[layer[id]] || (byLayer[layer[id]] = [])).push(id);

    const HGAP = 40, VGAP = 48;
    const maxL = reachable.length ? Math.max(...reachable.map(id => layer[id])) : 0;
    const layerY = {};
    let y = 0;
    for (let l = 0; l <= maxL; l++) {
      layerY[l] = y;
      const h = Math.max(0, ...(byLayer[l] || []).map(id => rect[id].h));
      y += h + VGAP;
    }

    const pos = {};
    for (let l = 0; l <= maxL; l++) {
      const row = byLayer[l] || [];
      const totalW = row.reduce((s, id) => s + rect[id].w, 0) + HGAP * Math.max(0, row.length - 1);
      let x = -totalW / 2;
      for (const id of row) {
        pos[id] = { x: x + rect[id].w / 2, y: layerY[l] + rect[id].h / 2 };
        x += rect[id].w + HGAP;
      }
    }

    // orphans parked in a right-hand column, below the widest layer
    const maxRowW = Math.max(0, ...Object.keys(byLayer).map(l =>
      byLayer[l].reduce((s, id) => s + rect[id].w, 0) + HGAP * Math.max(0, byLayer[l].length - 1)));
    const orphanX = maxRowW / 2 + HGAP * 2;
    let oy = 0;
    for (const id of orphans) {
      pos[id] = { x: orphanX + rect[id].w / 2, y: oy + rect[id].h / 2 };
      oy += rect[id].h + VGAP;
    }
    return pos;
  }

  // ---------------------------------------------------------------- editor
  class Flowchart {
    constructor(el, opts) {
      this.el = el;
      this.g = (opts && opts.graph) || sampleGraph();
      this.onChange = opts && opts.onChange;
      this._seq = 1;
      this._pos = {};      // node id -> {x,y} canvas-space centre (editor-only, not serialised)
      this._rect = {};
      this._selected = null;   // node id selected for behaviour insertion
      this._dragged = false;   // suppress the click that follows a drag
      this._lib = {};          // cached behaviour library {name: graph}
      this._server = null;     // true/false once the storage backend is probed
      this.el.addEventListener('input', ev => this.onField(ev));
      this.el.addEventListener('change', ev => this.onField(ev));
      this.el.addEventListener('click', ev => this.onClick(ev));
      this.el.addEventListener('mousedown', ev => this.onDown(ev));
      this.render();
      this._refreshLib();
    }

    getGraph() { return JSON.parse(JSON.stringify(this.g)); }
    setGraph(g) { this.g = g; this._pos = {}; this._selected = null; this.render(); }

    emit() { if (this.onChange) this.onChange(this.getGraph()); }

    _newId() {
      while (this.g.nodes['n' + this._seq]) this._seq++;
      return 'n' + this._seq++;
    }

    // ---- DOM builders ------------------------------------------------
    _targetSelect(edge, val) {
      const opts = ['<option value="">(none)</option>']
        + Object.keys(this.g.nodes).map(id =>
            `<option value="${id}"${id === val ? ' selected' : ''}>${GLYPH[this.g.nodes[id].type]} ${id}</option>`
          ).join('');
      const lab = edge === 'next' ? 'then' : edge;
      return `<label>${lab}<select class="fc-edge-sel" data-edge="${edge}">${opts}</select></label>`;
    }

    _nodeHTML(id, n) {
      const head = `<div class="fc-head"><span class="fc-glyph">${GLYPH[n.type]}</span>`
        + `<span>${n.type}</span><span class="fc-id">${id}</span>`
        + (n.type === 'start' ? '' : `<button class="fc-del" data-act="del" title="delete">\u00d7</button>`)
        + `</div>`;
      let body = '', says = '';
      if (n.type === 'decision') {
        body = n.conds.map((c, i) =>
          `<div class="fc-cond"><span class="fc-and">${i ? 'and' : 'if'}</span>`
          + nodeEditor('cond', c)
          + (n.conds.length > 1 ? `<button class="fc-mini" data-act="delcond" data-ci="${i}">\u00d7</button>` : '')
          + (i === n.conds.length - 1 ? `<button class="fc-mini" data-act="addcond" title="add condition">+</button>` : '')
          + `</div>`).join('');
        says = n.conds.map(condHTML).join(` ${kw('and')} `);
      } else if (n.type === 'action') {
        body = `<div class="fc-act"><span class="fc-and">do</span>${nodeEditor('act', n.act)}</div>`;
        says = actHTML(n.act);
      }
      const foot = n.type === 'decision'
        ? this._targetSelect('yes', n.yes) + this._targetSelect('no', n.no)
        : (n.type === 'end' ? '' : this._targetSelect('next', n.next));
      return `<div class="fc-node fc-${n.type}${this._selected === id ? ' fc-selected' : ''}" data-id="${id}">${head}`
        + `<div class="fc-body">${body}${says ? `<div class="fc-says">${says}</div>` : ''}</div>`
        + (foot ? `<div class="fc-foot">${foot}</div>` : '')
        + `</div>`;
    }

    // ---- geometry ----------------------------------------------------
    _ensurePositions() {
      const missing = Object.keys(this.g.nodes).filter(id => this._pos[id] == null);
      if (!missing.length) return;
      const rect = this._rect;
      const local = layout(this.g, rect);
      // anchor the auto-layout block at the top-left of the canvas
      let minL = Infinity, minT = Infinity;
      for (const id of missing) {
        minL = Math.min(minL, local[id].x - rect[id].w / 2);
        minT = Math.min(minT, local[id].y - rect[id].h / 2);
      }
      for (const id of missing) {
        this._pos[id] = { x: 60 + (local[id].x - minL), y: 60 + (local[id].y - minT) };
      }
    }

    _edge(s, sr, t, tr, label) {
      let x1 = s.x, y1 = s.y + sr.h / 2;
      if (label === 'yes') x1 = s.x - sr.w * 0.2;
      if (label === 'no')  x1 = s.x + sr.w * 0.2;
      const x2 = t.x, y2 = t.y - tr.h / 2;
      const dy = Math.max(30, Math.min(120, Math.abs(y2 - y1) / 2));
      const d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
      const l = label ? `<text x="${(x1 + x2) / 2 + 8}" y="${(y1 + y2) / 2 - 4}" class="fc-elabel">${label}</text>` : '';
      return `<path d="${d}" class="fc-edge" marker-end="url(#fc-arrow)"/>${l}`;
    }

    _applyGeometry() {
      const pos = this._pos, rect = this._rect;
      const PAD = 40;
      let W = 400, H = 300;
      for (const id in pos) {
        W = Math.max(W, pos[id].x + rect[id].w / 2 + PAD);
        H = Math.max(H, pos[id].y + rect[id].h / 2 + PAD);
      }
      const nodesEl = this.el.querySelector('.fc-nodes');
      for (const id in pos) {
        const el = nodesEl.querySelector(`[data-id="${id}"]`);
        el.style.left = (pos[id].x - rect[id].w / 2) + 'px';
        el.style.top  = (pos[id].y - rect[id].h / 2) + 'px';
      }
      const canvas = this.el.querySelector('.fc-canvas');
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      const svg = this.el.querySelector('.fc-edges');
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

      let edges = `<defs><marker id="fc-arrow" markerWidth="10" markerHeight="10"`
        + ` refX="8" refY="3" orient="auto" markerUnits="strokeWidth">`
        + `<path d="M0,0 L8,3 L0,6 z" fill="#4a5563"/></marker></defs>`;
      for (const id in this.g.nodes) {
        const n = this.g.nodes[id];
        if (n.type === 'end' || !pos[id]) continue;
        const s = pos[id], sr = rect[id];
        if (n.type === 'decision') {
          if (n.yes && pos[n.yes]) edges += this._edge(s, sr, pos[n.yes], rect[n.yes], 'yes');
          if (n.no  && pos[n.no])  edges += this._edge(s, sr, pos[n.no],  rect[n.no],  'no');
        } else if (n.next && pos[n.next]) {
          edges += this._edge(s, sr, pos[n.next], rect[n.next], null);
        }
      }
      svg.innerHTML = edges;
    }

    render() {
      this.el.classList.add('fc');
      this.el.innerHTML =
        `<div class="fc-toolbar">
           <button data-act="add-decision">+ decision</button>
           <button data-act="add-action">+ action</button>
           <button data-act="add-end">+ end</button>
           <button data-act="delete-all" class="fc-danger">delete all</button>
           <span class="fc-hint">each tick runs start \u2192 end · drag a node's header to move it</span>
         </div>
         <div class="fc-library">
           <input class="fc-lib-name" placeholder="behaviour name" title="Name for the current flowchart">
           <button data-act="save-behaviour">save behaviour</button>
           <select class="fc-lib-select" title="Saved behaviours">${this._libOptions()}</select>
           <button data-act="load-behaviour">load</button>
           <button data-act="insert-behaviour">insert at selected</button>
           <button data-act="delete-behaviour" class="fc-danger">delete</button>
           <span class="fc-hint">click a node's header to select it, then “insert” inlines a saved behaviour there</span>
         </div>
         <div class="fc-canvas">
           <svg class="fc-edges"></svg>
           <div class="fc-nodes"></div>
         </div>`;

      const nodesEl = this.el.querySelector('.fc-nodes');
      for (const id of Object.keys(this.g.nodes))
        nodesEl.insertAdjacentHTML('beforeend', this._nodeHTML(id, this.g.nodes[id]));

      this._rect = {};
      for (const el of nodesEl.children) this._rect[el.dataset.id] = { w: el.offsetWidth, h: el.offsetHeight };

      this._ensurePositions();
      this._applyGeometry();
    }

    // ---- editing ------------------------------------------------------
    _readContent(id, nodeEl) {
      const n = this.g.nodes[id];
      if (n.type === 'decision') {
        n.conds = [...nodeEl.querySelectorAll('.fc-node-editor[data-spec="cond"]')].map(readEditor);
        nodeEl.querySelector('.fc-says').innerHTML = n.conds.map(condHTML).join(` ${kw('and')} `);
      } else if (n.type === 'action') {
        n.act = readEditor(nodeEl.querySelector('.fc-node-editor[data-spec="act"]'));
        nodeEl.querySelector('.fc-says').innerHTML = actHTML(n.act);
      }
      this.emit();
    }

    _addNode(type) {
      const id = this._newId();
      const n = { type };
      if (type === 'decision') Object.assign(n, { conds: [['always']], yes: '', no: '' });
      if (type === 'action')   Object.assign(n, { act: ['act', ['source', 'hp', 1]], next: '' });
      this.g.nodes[id] = n;
      // default spot: below everything already on the canvas
      let maxB = 0;
      for (const k in this._pos) maxB = Math.max(maxB, this._pos[k].y + (this._rect[k] || {}).h / 2);
      this._pos[id] = { x: 220, y: maxB + 90 };
      this.render();
      this.emit();
    }

    _clearAll() {
      this.g = { nodes: { n1: { type: 'start', next: 'n2' }, n2: { type: 'end' } } };
      this._pos = {};
      this._seq = 1;
      this._selected = null;
      this.render();
      this.emit();
    }

    // ---- behaviour library (JSON files on the server, localStorage fallback) ---
    _library() {                      // local-only read, used when no server is reachable
      try {
        const raw = global.localStorage && global.localStorage.getItem(LIB_KEY);
        return raw ? (JSON.parse(raw) || {}) : {};
      } catch (e) { return this._memLib || (this._memLib = {}); }
    }
    _saveLibrary(lib) {               // local-only write
      try { global.localStorage.setItem(LIB_KEY, JSON.stringify(lib)); }
      catch (e) { this._memLib = lib; }
    }
    async _fetchLib() {
      try {
        const r = await fetch('/api/behaviours');
        if (!r.ok) throw new Error('http ' + r.status);
        this._server = true;
        return (await r.json()).behaviours || {};
      } catch (e) {
        this._server = false;
        return this._library();
      }
    }
    async _refreshLib() {
      this._lib = await this._fetchLib();
      const sel = this.el.querySelector('.fc-lib-select');
      if (sel) sel.innerHTML = this._libOptions();
    }
    _libOptions() {
      const names = Object.keys(this._lib);
      if (!names.length) return '<option value="">(no saved behaviours)</option>';
      return names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    }

    async _saveBehaviour() {
      const inp = this.el.querySelector('.fc-lib-name');
      const name = inp ? inp.value.trim() : '';
      if (!name) return;
      const graph = this.getGraph();
      await this._refreshLib();
      if (this._server) {
        try {
          const r = await fetch('/api/behaviours', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, graph }),
          });
          if (r.ok) this._lib = (await r.json()).behaviours || {};
        } catch (e) {}
      } else {
        this._lib[name] = graph;
        this._saveLibrary(this._lib);
      }
      this.render();
    }

    async _loadBehaviour() {
      const sel = this.el.querySelector('.fc-lib-select');
      const name = sel && sel.value;
      await this._refreshLib();
      const graph = this._lib[name];
      if (!name || !graph) return;
      this.setGraph(JSON.parse(JSON.stringify(graph)));
      this.emit();
    }

    async _deleteBehaviour() {
      const sel = this.el.querySelector('.fc-lib-select');
      const name = sel && sel.value;
      if (!name) return;
      await this._refreshLib();
      if (this._server) {
        try {
          const r = await fetch('/api/behaviours?name=' + encodeURIComponent(name),
                               { method: 'DELETE' });
          if (r.ok) this._lib = (await r.json()).behaviours || {};
        } catch (e) {}
      } else {
        delete this._lib[name];
        this._saveLibrary(this._lib);
      }
      this.render();
    }

    async _insertBehaviour() {
      const sel = this.el.querySelector('.fc-lib-select');
      const name = sel && sel.value;
      await this._refreshLib();
      const srcGraph = name && this._lib[name];
      if (!srcGraph) return;
      const target = this._selected;
      const tn = target && this.g.nodes[target];
      if (!tn) { alert('Select a node first — click an action or end node, then insert.'); return; }
      if (tn.type === 'start') { alert("The start node can't be replaced."); return; }
      if (tn.type === 'decision') { alert("A decision has two exits, so it can't be replaced by one behaviour. Replace an action or end node instead."); return; }

      const src = JSON.parse(JSON.stringify(srcGraph.nodes));
      const startId = Object.keys(src).find(id => src[id].type === 'start');
      const outTarget = tn.type === 'action' ? (tn.next || '') : '';
      const dropEnds = outTarget !== '';

      const newIds = {};
      for (const sid of Object.keys(src)) newIds[sid] = this._newId();

      // the behaviour's entry: whatever `start` pointed at, or — if that was a dropped
      // `end` — straight through to where the replaced node used to lead
      const entryRef = startId != null ? src[startId].next : '';
      const entry = !entryRef ? ''
        : (dropEnds && src[entryRef] && src[entryRef].type === 'end') ? outTarget
        : newIds[entryRef];

      const remapped = {};
      for (const sid of Object.keys(src)) {
        const sn = src[sid];
        if (sid === startId) continue;                 // entry is folded into `entry`
        if (dropEnds && sn.type === 'end') continue;   // a return becomes a jump to outTarget
        const nn = JSON.parse(JSON.stringify(sn));
        const mapEdge = ref => {
          if (!ref) return '';
          if (dropEnds && src[ref] && src[ref].type === 'end') return outTarget;
          return newIds[ref];
        };
        if (nn.type === 'decision') { nn.yes = mapEdge(nn.yes); nn.no = mapEdge(nn.no); }
        else if (nn.type !== 'end') { nn.next = mapEdge(nn.next); }
        remapped[newIds[sid]] = nn;
      }

      // re-point every edge that led into the replaced node, to the behaviour's entry
      for (const k in this.g.nodes) {
        const n = this.g.nodes[k];
        if (k === target) continue;
        if (n.type === 'decision') {
          if (n.yes === target) n.yes = entry;
          if (n.no === target) n.no = entry;
        } else if (n.type !== 'end') {
          if (n.next === target) n.next = entry;
        }
      }

      Object.assign(this.g.nodes, remapped);
      delete this.g.nodes[target];
      delete this._pos[target];
      this._selected = null;
      this.render();
      this.emit();
    }

    _delNode(id) {
      delete this.g.nodes[id];
      delete this._pos[id];
      if (this._selected === id) this._selected = null;
      for (const k in this.g.nodes) {
        const n = this.g.nodes[k];
        if (n.type === 'decision') { if (n.yes === id) n.yes = ''; if (n.no === id) n.no = ''; }
        else if (n.type !== 'end') { if (n.next === id) n.next = ''; }
      }
      this.render();
      this.emit();
    }

    // ---- events -------------------------------------------------------
    onDown(ev) {
      const head = ev.target.closest('.fc-head');
      if (!head || ev.target.closest('button')) return;   // drag by the header, not the ×
      const id = head.closest('.fc-node').dataset.id;
      const orig = { x: this._pos[id].x, y: this._pos[id].y };
      const startX = ev.clientX, startY = ev.clientY;
      let moved = false;
      this._dragged = false;
      ev.preventDefault();
      const move = e => {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) moved = true;
        this._pos[id] = {
          x: Math.max(40, orig.x + (e.clientX - startX)),
          y: Math.max(40, orig.y + (e.clientY - startY)),
        };
        this._applyGeometry();
      };
      const up = () => {
        this._dragged = moved;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.el.classList.remove('fc-dragging');
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      this.el.classList.add('fc-dragging');
    }

    onField(ev) {
      const t = ev.target;
      if (!this.el.contains(t)) return;   // the target was re-rendered under us
      if (t.classList.contains('fc-edge-sel')) {
        const nodeEl = t.closest('.fc-node');
        this.g.nodes[nodeEl.dataset.id][t.dataset.edge] = t.value || '';
        this.render(); this.emit();
        return;
      }
      if (t.classList.contains('fc-kind')) {
        const ed = t.closest('.fc-node-editor');
        const spec = ed.dataset.spec;
        const nodeEl = t.closest('.fc-node');
        const parent = ed.parentElement.closest('.fc-node-editor');
        const parentKind = parent && parent.dataset.spec === 'act'
          ? parent.querySelector(':scope > select.fc-kind').value : null;
        if (spec === 'sel' && parentKind === 'act') {
          parent.outerHTML = nodeEditor('act', actWith(defaultFor('sel', t.value)));
        } else {
          ed.outerHTML = nodeEditor(spec, defaultFor(spec, t.value));
        }
        this._readContent(nodeEl.dataset.id, nodeEl);
        this.render();
        return;
      }
      const nodeEl = t.closest('.fc-node');
      if (nodeEl && t.closest('.fc-body')) this._readContent(nodeEl.dataset.id, nodeEl);
    }

    onClick(ev) {
      if (!this.el.contains(ev.target)) return;
      const b = ev.target.closest('button[data-act]');
      if (b) {
        const nodeEl = ev.target.closest('.fc-node');
        const id = nodeEl && nodeEl.dataset.id;
        switch (b.dataset.act) {
          case 'add-decision': this._addNode('decision'); break;
          case 'add-action':   this._addNode('action'); break;
          case 'add-end':      this._addNode('end'); break;
          case 'delete-all':   this._clearAll(); break;
          case 'save-behaviour':   this._saveBehaviour(); break;
          case 'load-behaviour':   this._loadBehaviour(); break;
          case 'insert-behaviour': this._insertBehaviour(); break;
          case 'delete-behaviour': this._deleteBehaviour(); break;
          case 'del': {
            if (this.g.nodes[id].type !== 'start') this._delNode(id);
            break;
          }
          case 'addcond': this.g.nodes[id].conds.push(['always']); this.render(); this.emit(); break;
          case 'delcond': {
            const ci = +b.dataset.ci;
            if (this.g.nodes[id].conds.length > 1) this.g.nodes[id].conds.splice(ci, 1);
            this.render(); this.emit();
            break;
          }
        }
        return;
      }
      if (this._dragged) { this._dragged = false; return; }
      if (ev.target.closest('button, select, input, label')) return;   // editing, not selecting
      const nodeEl = ev.target.closest('.fc-node');
      if (nodeEl) {
        const id = nodeEl.dataset.id;
        this._selected = (this._selected === id) ? null : id;
        this.render();
        return;
      }
      if (this._selected) { this._selected = null; this.render(); }
    }
  }

  Flowchart.sample = sampleGraph;
  global.Flowchart = Flowchart;
})(typeof window !== 'undefined' ? window : globalThis);
