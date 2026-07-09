// Plain-node tests for the terminal theme presets + appearance normalization
// (no framework: run `node test/themes.test.js`). themes.js is dual-mode
// (browser global + CommonJS), so it can be required straight into Node.
const assert = require('assert');
const T = require('../renderer/themes');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const HEX = /^#[0-9a-fA-F]{6}$/;
const CORE = ['background', 'foreground', 'cursor', 'selectionBackground'];
const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

test('exposes exactly 6 themes', () => {
  assert.strictEqual(T.THEMES.length, 6);
});

test('every theme has a non-empty id and name; ids are unique', () => {
  const ids = new Set();
  for (const t of T.THEMES) {
    assert.ok(t.id && typeof t.id === 'string', 'id');
    assert.ok(t.name && typeof t.name === 'string', 'name');
    assert.ok(!ids.has(t.id), 'duplicate id: ' + t.id);
    ids.add(t.id);
  }
});

test('every theme has all core + 16 ANSI keys as valid hex', () => {
  for (const t of T.THEMES) {
    for (const k of [...CORE, ...ANSI]) {
      assert.ok(HEX.test(t.xterm[k]), `${t.id}.${k} = ${t.xterm[k]}`);
    }
  }
});

test('swarm-dark preserves the current hardcoded defaults (regression)', () => {
  const x = T.getTheme('swarm-dark').xterm;
  assert.strictEqual(x.background, '#0d0f12');
  assert.strictEqual(x.foreground, '#c9d1d9');
  assert.strictEqual(x.cursor, '#3fd0c9');
  assert.strictEqual(x.selectionBackground, '#2b3640');
});

test('getTheme returns null for unknown id', () => {
  assert.strictEqual(T.getTheme('nope'), null);
});

test('normalizeAppearance fills defaults from empty/garbage input', () => {
  const a = T.normalizeAppearance(null);
  assert.strictEqual(a.theme, 'swarm-dark');
  assert.strictEqual(a.fontSize, 13);
  assert.strictEqual(a.cursorStyle, 'block');
  assert.strictEqual(a.cursorBlink, true);
  assert.ok(a.fontFamily.length > 0);
});

test('normalizeAppearance falls back on unknown theme', () => {
  assert.strictEqual(T.normalizeAppearance({ theme: 'bogus' }).theme, 'swarm-dark');
});

test('normalizeAppearance clamps fontSize to 10..20', () => {
  assert.strictEqual(T.normalizeAppearance({ fontSize: 4 }).fontSize, 10);
  assert.strictEqual(T.normalizeAppearance({ fontSize: 99 }).fontSize, 20);
  assert.strictEqual(T.normalizeAppearance({ fontSize: '15' }).fontSize, 15);
});

test('normalizeAppearance rejects a bad cursorStyle', () => {
  assert.strictEqual(T.normalizeAppearance({ cursorStyle: 'spiral' }).cursorStyle, 'block');
  assert.strictEqual(T.normalizeAppearance({ cursorStyle: 'bar' }).cursorStyle, 'bar');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
