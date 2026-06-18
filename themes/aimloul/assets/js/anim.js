/*
 * Declarative animation framework.
 *
 * The theme owns this runtime; each article owns its animation in its own page
 * bundle (e.g. content/.../my-article/foo.anim.js) and registers it with:
 *
 *   Anim.define('foo', {
 *     label: 'accessible name',
 *     controls: [
 *       { type: 'number', name: 'value', placeholder: 'value', submit: 'insert' },
 *       { type: 'button', name: 'insert', label: 'Insert', primary: true },
 *       { type: 'button', name: 'reset',  label: 'Reset', muted: true },
 *     ],
 *     setup(ctx) { return state; },          // build a plain data model
 *     draw(ctx, state, s) {                  // declarative scene, logical coords
 *       s.rows(4);                           // number of stacked lanes (rows)
 *       s.box('a0', { col: 0, row: 0, text: 'A' });   // a single cell at row 0
 *       s.box('a1', { col: 0, row: 1 });              // empty pointer slot above it
 *       s.rule('a', { col: 0, fromRow: 0, toRow: 1 });// spine joining the column
 *       s.box('b', { col: 1, row: 0, text: 'B' });
 *       s.link('a-b', 'a0', 'b', { row: 0 });
 *       s.lane(0, 'L0');
 *     },
 *     actions: {                             // return a timeline of steps
 *       insert: (ctx, state) => ([
 *         { say: 'coin flips…', hold: 900 },
 *         { commit: () => mutate(state), found: 'b', say: 'spliced in' },
 *       ]),
 *       reset: (ctx, state) => ([{ commit: () => reset(state), say: 'reset' }]),
 *     },
 *   });
 *
 * Step fields (all optional): focus / trace / found (element id or array of ids),
 * say (status text), commit (mutate model then redraw before highlighting),
 * clear (wipe highlights first), hold (ms to pause after, defaults to spec.pace).
 *
 * An action may instead return a plain string to just set the status (e.g. for
 * input validation), or nothing to do nothing.
 *
 * The runtime builds the controls, SVG stage and status line, computes all
 * pixel geometry, toggles highlight classes, paces the timeline, honours
 * prefers-reduced-motion, auto-scrolls on mobile, and locks out overlapping runs.
 * Default visual styling for boxes/links/highlights lives in the theme CSS, so a
 * typical animation needs no CSS of its own.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var registry = {};
  var pending = [];

  var DEFAULT_LAYOUT = {
    cellW: 48, cellH: 30, colPitch: 74, rowPitch: 52, padX: 20, padY: 18, laneX: 4,
  };
  var DEFAULT_PACE = 760;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    }
    return n;
  }
  function toArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

  // ── sketch: logical-coordinate scene builder ──
  function makeSketch(layout) {
    var L = layout;
    var totalRows = 1, maxCol = 0;
    var els = {};
    var markerId = 'anim-arw-' + Math.random().toString(36).slice(2);
    var laneLayer = svgEl('g'), linkLayer = svgEl('g'), nodeLayer = svgEl('g');

    function laneY(r) { return L.padY + (totalRows - 1 - r) * L.rowPitch; }
    function colX(c) { return L.padX + c * L.colPitch + (L.colPitch - L.cellW) / 2; }

    var api = {
      rows: function (n) { totalRows = n; },

      box: function (id, o) {
        maxCol = Math.max(maxCol, o.col);
        var row = o.row || 0, span = o.rowSpan || 1, topRow = row + span - 1;
        var x = colX(o.col), yTop = laneY(topRow), yBot = laneY(row);
        var cls = 'anim-box';
        if (o.variant) o.variant.split(/\s+/).forEach(function (v) { if (v) cls += ' is-' + v; });
        var g = svgEl('g', { class: cls });
        g.appendChild(svgEl('rect', {
          x: x, y: yTop, width: L.cellW, height: (yBot - yTop) + L.cellH, rx: 6,
        }));
        if (o.text != null && o.text !== '') {
          var t = svgEl('text', { x: x + L.cellW / 2, y: yBot + L.cellH / 2 + 4, 'text-anchor': 'middle' });
          t.textContent = o.text;
          g.appendChild(t);
        }
        g.__cx = x + L.cellW / 2;
        els[id] = g;
        nodeLayer.appendChild(g);
      },

      // vertical guide connecting cells of a stacked column (e.g. a tower)
      rule: function (id, o) {
        var x = colX(o.col) + L.cellW / 2;
        linkLayer.appendChild(svgEl('line', {
          x1: x, y1: laneY(o.toRow) + L.cellH / 2,
          x2: x, y2: laneY(o.fromRow) + L.cellH / 2,
          class: 'anim-rule',
        }));
      },

      link: function (id, fromId, toId, o) {
        var from = els[fromId], to = els[toId];
        if (!from || !to) return;
        var x1 = from.__cx + L.cellW / 2;
        var x2 = to.__cx - L.cellW / 2;
        var y = laneY(o.row) + L.cellH / 2;
        var line = svgEl('line', {
          x1: x1, y1: y, x2: x2 - 7, y2: y, class: 'anim-link',
          'marker-end': 'url(#' + markerId + ')',
        });
        line.__cx = x2;
        els[id] = line;
        linkLayer.appendChild(line);
      },

      lane: function (row, text) {
        var t = svgEl('text', { x: L.laneX, y: laneY(row) + L.cellH / 2 + 4, class: 'anim-lane' });
        t.textContent = text;
        laneLayer.appendChild(t);
      },
    };

    function commit(stage, setSize) {
      while (stage.firstChild) stage.removeChild(stage.firstChild);
      var defs = svgEl('defs');
      var marker = svgEl('marker', {
        id: markerId, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3,
        orient: 'auto', markerUnits: 'userSpaceOnUse',
      });
      marker.appendChild(svgEl('path', { d: 'M0,0 L6,3 L0,6 Z', class: 'anim-arrow' }));
      defs.appendChild(marker);
      stage.appendChild(defs);
      stage.appendChild(laneLayer);
      stage.appendChild(linkLayer);
      stage.appendChild(nodeLayer);
      setSize(L.padX * 2 + (maxCol + 1) * L.colPitch, L.padY * 2 + totalRows * L.rowPitch);
    }

    return { api: api, els: els, commit: commit };
  }

  // ── widget ──
  function buildCtx(container, spec) {
    var layout = Object.assign({}, DEFAULT_LAYOUT, spec.layout || {});
    var pace = spec.pace || DEFAULT_PACE;
    var inputs = {};
    var stage, viewport, statusEl, els = {};
    var busy = false;

    var ctx = {
      el: container,
      state: null,
      value: function (name) { return inputs[name] ? inputs[name].value : undefined; },
      number: function (name) { var v = parseInt(ctx.value(name), 10); return isNaN(v) ? null : v; },
      config: function (key, fb) { var v = container.dataset[key]; return (v == null || v === '') ? fb : v; },
      status: function (msg) { statusEl.textContent = msg; },
      render: function () {
        var sk = makeSketch(layout);
        spec.draw(ctx, ctx.state, sk.api);
        sk.commit(stage, function (w, h) {
          stage.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
          stage.setAttribute('width', w);
          stage.setAttribute('height', h);
        });
        els = sk.els;
      },
    };

    function clearHighlights() {
      for (var id in els) if (els[id]) els[id].classList.remove('is-active', 'is-traversed', 'is-found');
    }
    function autoScroll(id) {
      if (reducedMotion() || !els[id]) return;
      if (viewport.scrollWidth <= viewport.clientWidth) return;
      var w = parseFloat(stage.getAttribute('width')) || stage.clientWidth;
      if (!w) return;
      var x = els[id].__cx || 0;
      viewport.scrollTo({ left: Math.max(0, x * (viewport.scrollWidth / w) - viewport.clientWidth / 2), behavior: 'smooth' });
    }
    function applyStep(st) {
      if (st.clear) clearHighlights();
      if (st.commit) { st.commit(); ctx.render(); }
      var lastFocus = null;
      toArray(st.focus).forEach(function (id) { if (els[id]) { els[id].classList.add('is-active'); lastFocus = id; } });
      toArray(st.trace).forEach(function (id) { if (els[id]) els[id].classList.add('is-traversed'); });
      toArray(st.found).forEach(function (id) { if (els[id]) { els[id].classList.add('is-active', 'is-found'); lastFocus = id; } });
      if (st.say != null) ctx.status(st.say);
      if (lastFocus) autoScroll(lastFocus);
    }
    function play(steps) {
      clearHighlights();
      var i = 0;
      function step() {
        if (i >= steps.length) return Promise.resolve();
        applyStep(steps[i++]);
        if (i >= steps.length) return Promise.resolve();
        var hold = steps[i - 1].hold != null ? steps[i - 1].hold : pace;
        if (reducedMotion()) hold = 0;
        return new Promise(function (r) { setTimeout(r, hold); }).then(step);
      }
      return step();
    }
    function trigger(name) {
      if (busy) return;
      var fn = spec.actions && spec.actions[name];
      if (!fn) return;
      var out;
      try { out = fn(ctx, ctx.state); } catch (e) { return; }
      if (typeof out === 'string') { ctx.status(out); return; }
      if (!out || !out.length) return;
      busy = true;
      container.classList.add('is-busy');
      play(out).catch(function () {}).then(function () { busy = false; container.classList.remove('is-busy'); });
    }

    // ── chrome ──
    container.classList.add('anim');
    var caption = container.querySelector('figcaption');

    var controlsEl = document.createElement('div');
    controlsEl.className = 'anim-controls';
    (spec.controls || []).forEach(function (c) {
      if (c.type === 'number' || c.type === 'text') {
        var field = document.createElement('div');
        field.className = 'anim-field';
        var input = document.createElement('input');
        input.type = (c.type === 'number') ? 'number' : 'text';
        if (c.type === 'number') input.inputMode = 'numeric';
        input.className = 'anim-input';
        if (c.placeholder) input.placeholder = c.placeholder;
        input.setAttribute('aria-label', c.label || c.name);
        inputs[c.name] = input;
        if (c.submit) input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); trigger(c.submit); }
        });
        field.appendChild(input);
        controlsEl.appendChild(field);
      } else if (c.type === 'button') {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'anim-btn' + (c.primary ? ' is-primary' : '') + (c.muted ? ' is-muted' : '');
        btn.textContent = c.label || c.name;
        if (c.ariaLabel) btn.setAttribute('aria-label', c.ariaLabel);
        var action = c.action || c.name;
        btn.addEventListener('click', function () { trigger(action); });
        controlsEl.appendChild(btn);
      }
    });

    viewport = document.createElement('div');
    viewport.className = 'anim-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('aria-label', spec.label || 'Interactive animation');
    stage = svgEl('svg', { class: 'anim-stage', role: 'img' });
    viewport.appendChild(stage);

    statusEl = document.createElement('p');
    statusEl.className = 'anim-status';
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');

    if (spec.controls && spec.controls.length) container.insertBefore(controlsEl, caption);
    container.insertBefore(viewport, caption);
    container.insertBefore(statusEl, caption);

    if (spec.css && !document.querySelector('style[data-anim-css="' + spec._name + '"]')) {
      var style = document.createElement('style');
      style.setAttribute('data-anim-css', spec._name);
      style.textContent = spec.css;
      document.head.appendChild(style);
    }

    ctx.state = spec.setup ? spec.setup(ctx) : {};
    ctx.render();
  }

  function mount(container) {
    if (container.dataset.animReady) return;
    var spec = registry[container.dataset.anim];
    if (!spec) { if (pending.indexOf(container) === -1) pending.push(container); return; }
    container.dataset.animReady = '1';
    try { buildCtx(container, spec); } catch (e) { /* leave inert */ }
  }
  function define(name, spec) {
    spec._name = name;
    registry[name] = spec;
    pending = pending.filter(function (c) {
      if (c.dataset.anim === name) { mount(c); return false; }
      return true;
    });
  }
  function initAll() { document.querySelectorAll('[data-anim]').forEach(mount); }

  window.Anim = { define: define };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
