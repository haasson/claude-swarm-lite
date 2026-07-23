// tabstyle.js — tab card appearance data + pure helpers. Dual-mode: attaches to
// window.SWARM_TABSTYLE in the browser (loaded via <script> before renderer.js),
// and exports via module.exports under Node so test/tabstyle.test.js can require it.
// NO DOM here — just data and validation, so it's unit-testable in Node.
//
// Density is applied as a CLASS (it flips a batch of CSS vars declared in
// styles.css); sizes and colors are applied as CSS VARS. Keep that split — it's
// why toCssVars() emits only seven names and bodyClasses() owns the rest.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_TABSTYLE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DENSITIES = [
    { id: 'compact', name: 'Компактная' },
    { id: 'normal', name: 'Обычная' },
    { id: 'roomy', name: 'Просторная' },
  ];

  // Status colors double as the app-wide palette (statusbar, buttons read the
  // same vars). Deliberate: the alternative is duplicating five variables.
  const COLORS = [
    { key: 'accent', name: 'Активная' },
    { key: 'run', name: 'Работает' },
    { key: 'ready', name: 'Готова' },
    { key: 'waiting', name: 'Ждёт ввода' },
    { key: 'danger', name: 'Ошибка' },
  ];

  // `agents` — show the sub-agent badge (icon + count) on the card.
  // `agentOrange` — keep the status «работает» (orange) while sub-agents run, even
  //   when the main thread is idle. Unlike the others it has NO CSS class: the
  //   renderer reads it in onStatus (see effectiveStatus), so bodyClasses skips it.
  const SHOW_KEYS = ['dot', 'ctx', 'sub', 'statusFill', 'agents', 'agentOrange'];

  // Colors mirror the hardcoded :root palette (styles.css:10-22) — pinned by a
  // regression test, so a change there must be mirrored here.
  const DEFAULT_TABSTYLE = {
    density: 'normal',
    show: { dot: true, ctx: true, sub: true, statusFill: true, agents: true, agentOrange: true },
    labelSize: 12,
    subSize: 10,
    colors: {
      accent: '#3fd0c9',
      run: '#e0a53f',
      ready: '#4ade80',
      waiting: '#3fd0c9',
      danger: '#e05a5a',
    },
  };

  const HEX = /^#[0-9a-fA-F]{6}$/;

  function clampInt(v, lo, hi, dflt) {
    let n = parseInt(v, 10);
    if (!Number.isFinite(n)) n = dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  // Coerce any stored/garbage value into a valid tab style. Never throws.
  // Returns a deep copy, so callers can use it to fork an editable draft.
  function normalizeTabStyle(raw) {
    const d = DEFAULT_TABSTYLE;
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const rShow = (r.show && typeof r.show === 'object') ? r.show : {};
    const rColors = (r.colors && typeof r.colors === 'object') ? r.colors : {};
    const show = {};
    SHOW_KEYS.forEach(function (k) {
      show[k] = typeof rShow[k] === 'boolean' ? rShow[k] : d.show[k];
    });
    const colors = {};
    COLORS.forEach(function (c) {
      const v = rColors[c.key];
      colors[c.key] = (typeof v === 'string' && HEX.test(v)) ? v.toLowerCase() : d.colors[c.key];
    });
    return {
      density: DENSITIES.some(function (x) { return x.id === r.density; }) ? r.density : d.density,
      show: show,
      labelSize: clampInt(r.labelSize, 9, 18, d.labelSize),
      subSize: clampInt(r.subSize, 8, 14, d.subSize),
      colors: colors,
    };
  }

  // Sizes + colors → CSS custom properties. Normalizes first, so a caller can
  // pass a half-built draft without leaking garbage into the stylesheet.
  function toCssVars(style) {
    const s = normalizeTabStyle(style);
    const out = {
      '--tab-label-size': s.labelSize + 'px',
      '--tab-sub-size': s.subSize + 'px',
    };
    COLORS.forEach(function (c) { out['--' + c.key] = s.colors[c.key]; });
    return out;
  }

  // Density + visibility → class names. Order is stable (density first) so the
  // result can be compared verbatim in tests.
  function bodyClasses(style) {
    const s = normalizeTabStyle(style);
    const out = ['tabs-' + s.density];
    if (!s.show.dot) out.push('tab-no-dot');
    if (!s.show.ctx) out.push('tab-no-ctx');
    if (!s.show.sub) out.push('tab-no-sub');
    if (!s.show.statusFill) out.push('tab-no-fill');
    if (!s.show.agents) out.push('tab-no-agents');
    // NB: agentOrange has no class — it drives JS status logic, not CSS.
    return out;
  }

  return { DENSITIES, COLORS, DEFAULT_TABSTYLE, normalizeTabStyle, toCssVars, bodyClasses };
});
