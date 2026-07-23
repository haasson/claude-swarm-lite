// Plain-node tests for the tab card style settings (no framework: run
// `node test/tabstyle.test.js`). tabstyle.js is dual-mode (browser global +
// CommonJS), so it can be required straight into Node.
const assert = require('assert');
const T = require('../renderer/tabstyle');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const HEX = /^#[0-9a-fA-F]{6}$/;

test('exposes three densities with unique ids and names', () => {
  assert.strictEqual(T.DENSITIES.length, 3);
  const ids = T.DENSITIES.map((d) => d.id);
  assert.deepStrictEqual(ids, ['compact', 'normal', 'roomy']);
  for (const d of T.DENSITIES) assert.ok(d.name && typeof d.name === 'string', d.id);
});

test('COLORS describes exactly the keys of DEFAULT_TABSTYLE.colors', () => {
  const listed = T.COLORS.map((c) => c.key).sort();
  const actual = Object.keys(T.DEFAULT_TABSTYLE.colors).sort();
  assert.deepStrictEqual(listed, actual);
  for (const c of T.COLORS) assert.ok(c.name && typeof c.name === 'string', c.key);
});

test('default colors mirror the hardcoded :root palette (regression)', () => {
  // styles.css:10-22 — если правишь палитру там, правь и здесь.
  assert.deepStrictEqual(T.DEFAULT_TABSTYLE.colors, {
    accent:  '#3fd0c9',
    run:     '#e0a53f',
    ready:   '#4ade80',
    waiting: '#3fd0c9',
    danger:  '#e05a5a',
  });
});

test('every default color is a valid hex', () => {
  for (const k of Object.keys(T.DEFAULT_TABSTYLE.colors)) {
    assert.ok(HEX.test(T.DEFAULT_TABSTYLE.colors[k]), k);
  }
});

test('normalizeTabStyle fills defaults from empty/garbage input', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const s = T.normalizeTabStyle(bad);
    assert.strictEqual(s.density, 'normal', String(bad));
    assert.strictEqual(s.labelSize, 12);
    assert.strictEqual(s.subSize, 10);
    assert.deepStrictEqual(s.show, { dot: true, ctx: true, sub: true, statusFill: true, agents: true, agentOrange: true });
    assert.deepStrictEqual(s.colors, T.DEFAULT_TABSTYLE.colors);
  }
});

test('normalizeTabStyle falls back on unknown density', () => {
  assert.strictEqual(T.normalizeTabStyle({ density: 'bogus' }).density, 'normal');
  assert.strictEqual(T.normalizeTabStyle({ density: 'compact' }).density, 'compact');
});

test('normalizeTabStyle clamps labelSize to 9..18 and subSize to 8..14', () => {
  assert.strictEqual(T.normalizeTabStyle({ labelSize: 2 }).labelSize, 9);
  assert.strictEqual(T.normalizeTabStyle({ labelSize: 99 }).labelSize, 18);
  assert.strictEqual(T.normalizeTabStyle({ labelSize: '15' }).labelSize, 15);
  assert.strictEqual(T.normalizeTabStyle({ labelSize: 'abc' }).labelSize, 12);
  assert.strictEqual(T.normalizeTabStyle({ subSize: 1 }).subSize, 8);
  assert.strictEqual(T.normalizeTabStyle({ subSize: 99 }).subSize, 14);
  assert.strictEqual(T.normalizeTabStyle({ subSize: '11' }).subSize, 11);
});

test('normalizeTabStyle keeps valid booleans and fills missing ones', () => {
  const s = T.normalizeTabStyle({ show: { dot: false, sub: 'yes' } });
  assert.strictEqual(s.show.dot, false);
  assert.strictEqual(s.show.sub, true, 'non-boolean falls back to default');
  assert.strictEqual(s.show.ctx, true);
  assert.strictEqual(s.show.statusFill, true);
  assert.strictEqual(s.show.agents, true);
  assert.strictEqual(s.show.agentOrange, true);
});

test('normalizeTabStyle rejects a bad hex and lowercases a good one', () => {
  const s = T.normalizeTabStyle({ colors: { accent: 'red', run: '#ABCDEF' } });
  assert.strictEqual(s.accent, undefined, 'colors live under .colors');
  assert.strictEqual(s.colors.accent, T.DEFAULT_TABSTYLE.colors.accent);
  assert.strictEqual(s.colors.run, '#abcdef');
});

test('normalizeTabStyle deep-copies: mutating the result leaves input alone', () => {
  const input = T.normalizeTabStyle(null);
  const copy = T.normalizeTabStyle(input);
  copy.show.dot = false;
  copy.colors.accent = '#000000';
  assert.strictEqual(input.show.dot, true);
  assert.strictEqual(input.colors.accent, T.DEFAULT_TABSTYLE.colors.accent);
});

test('toCssVars returns exactly the seven vars, with units on sizes', () => {
  const v = T.toCssVars(T.normalizeTabStyle(null));
  assert.deepStrictEqual(Object.keys(v).sort(), [
    '--accent', '--danger', '--ready', '--run', '--tab-label-size', '--tab-sub-size', '--waiting',
  ]);
  assert.strictEqual(v['--tab-label-size'], '12px');
  assert.strictEqual(v['--tab-sub-size'], '10px');
  assert.strictEqual(v['--accent'], '#3fd0c9');
});

test('toCssVars normalizes garbage instead of emitting it', () => {
  const v = T.toCssVars({ labelSize: 999, colors: { danger: 'oops' } });
  assert.strictEqual(v['--tab-label-size'], '18px');
  assert.strictEqual(v['--danger'], T.DEFAULT_TABSTYLE.colors.danger);
});

test('bodyClasses always names the density and nothing else by default', () => {
  assert.deepStrictEqual(T.bodyClasses(T.normalizeTabStyle(null)), ['tabs-normal']);
  assert.deepStrictEqual(T.bodyClasses({ density: 'compact' }), ['tabs-compact']);
});

test('bodyClasses adds one tab-no-* class per hidden element', () => {
  const all = T.bodyClasses({ show: { dot: false, ctx: false, sub: false, statusFill: false, agents: false } });
  assert.deepStrictEqual(all, ['tabs-normal', 'tab-no-dot', 'tab-no-ctx', 'tab-no-sub', 'tab-no-fill', 'tab-no-agents']);
  assert.deepStrictEqual(T.bodyClasses({ show: { sub: false } }), ['tabs-normal', 'tab-no-sub']);
});

test('bodyClasses emits no class for agentOrange (JS-only toggle)', () => {
  assert.deepStrictEqual(T.bodyClasses({ show: { agentOrange: false } }), ['tabs-normal']);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
