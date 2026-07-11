// Plain-node tests for keybind normalization + matching (no framework:
// run `node test/keybinds.test.js`). keybinds.js is dual-mode.
const assert = require('assert');
const K = require('../renderer/keybinds');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function fakeEv(partial) {
  return {
    key: partial.key,
    metaKey: !!partial.meta,
    ctrlKey: !!partial.ctrl,
    altKey: !!partial.alt,
    shiftKey: !!partial.shift,
  };
}

test('ACTIONS has 6 fixed ids with kinds', () => {
  assert.strictEqual(K.ACTIONS.length, 6);
  const ids = K.ACTIONS.map((a) => a.id);
  assert.deepStrictEqual(ids, [
    'newline', 'wordLeft', 'wordRight', 'lineStart', 'lineEnd', 'scrollBottom',
  ]);
  assert.strictEqual(K.ACTIONS.find((a) => a.id === 'scrollBottom').kind, 'app');
  assert.strictEqual(K.ACTIONS.find((a) => a.id === 'newline').kind, 'input');
});

test('BYTES are non-empty for every input action', () => {
  for (const a of K.ACTIONS) {
    if (a.kind !== 'input') continue;
    assert.ok(typeof K.BYTES[a.id] === 'string' && K.BYTES[a.id].length > 0, a.id);
  }
  assert.strictEqual(K.BYTES.newline, '\n');
  assert.strictEqual(K.BYTES.wordLeft, '\x1bb');
  assert.strictEqual(K.BYTES.lineEnd, '\x05');
});

test('normalizeKeybinds fills darwin defaults from empty/garbage', () => {
  const b = K.normalizeKeybinds(null, 'darwin');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_DARWIN.newline);
  assert.deepStrictEqual(b.scrollBottom, K.DEFAULT_KEYBINDS_DARWIN.scrollBottom);
  const g = K.normalizeKeybinds('nope', 'darwin');
  assert.deepStrictEqual(g.wordLeft, K.DEFAULT_KEYBINDS_DARWIN.wordLeft);
});

test('normalizeKeybinds fills win defaults (Ctrl / Home / End)', () => {
  const b = K.normalizeKeybinds(null, 'win32');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_WIN.newline);
  assert.deepStrictEqual(b.wordLeft, K.DEFAULT_KEYBINDS_WIN.wordLeft);
  assert.deepStrictEqual(b.lineStart, K.DEFAULT_KEYBINDS_WIN.lineStart);
  assert.strictEqual(b.newline.ctrl, true);
  assert.strictEqual(b.newline.meta, false);
  assert.strictEqual(b.lineEnd.key, 'End');
});

test('normalizeKeybinds migrates leftover mac defaults on win32', () => {
  const b = K.normalizeKeybinds({
    newline: { ...K.DEFAULT_KEYBINDS_DARWIN.newline },
    wordLeft: { ...K.DEFAULT_KEYBINDS_DARWIN.wordLeft },
  }, 'win32');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_WIN.newline);
  assert.deepStrictEqual(b.wordLeft, K.DEFAULT_KEYBINDS_WIN.wordLeft);
});

test('normalizeKeybinds keeps explicit null (cleared binding)', () => {
  const b = K.normalizeKeybinds({ newline: null }, 'darwin');
  assert.strictEqual(b.newline, null);
  assert.deepStrictEqual(b.wordRight, K.DEFAULT_KEYBINDS_DARWIN.wordRight);
});

test('normalizeKeybinds rejects reserved chords and falls back to default', () => {
  const b = K.normalizeKeybinds({
    newline: { key: 't', meta: true, ctrl: false, alt: false, shift: false },
  }, 'darwin');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_DARWIN.newline);
});

test('normalizeKeybinds accepts a custom valid chord', () => {
  const chord = { key: 'Enter', meta: false, ctrl: false, alt: false, shift: true };
  const b = K.normalizeKeybinds({ newline: chord }, 'win32');
  assert.deepStrictEqual(b.newline, chord);
});

test('chordMatches Meta+Enter for darwin newline default', () => {
  const b = K.normalizeKeybinds({}, 'darwin');
  assert.ok(K.chordMatches(b.newline, fakeEv({ key: 'Enter', meta: true })));
  assert.ok(!K.chordMatches(b.newline, fakeEv({ key: 'Enter' })));
});

test('matchInputKeybind returns action id (darwin)', () => {
  const b = K.normalizeKeybinds({}, 'darwin');
  assert.strictEqual(
    K.matchInputKeybind(b, fakeEv({ key: 'ArrowLeft', meta: true })),
    'wordLeft'
  );
  assert.strictEqual(
    K.matchInputKeybind(b, fakeEv({ key: 'ArrowLeft', ctrl: true })),
    'lineStart'
  );
  assert.strictEqual(K.matchInputKeybind(b, fakeEv({ key: 'a' })), null);
});

test('matchInputKeybind uses Ctrl/Home on win32', () => {
  const b = K.normalizeKeybinds({}, 'win32');
  assert.strictEqual(
    K.matchInputKeybind(b, fakeEv({ key: 'Enter', ctrl: true })),
    'newline'
  );
  assert.strictEqual(
    K.matchInputKeybind(b, fakeEv({ key: 'ArrowLeft', ctrl: true })),
    'wordLeft'
  );
  assert.strictEqual(
    K.matchInputKeybind(b, fakeEv({ key: 'Home' })),
    'lineStart'
  );
});

test('matchAppKeybind matches scrollBottom', () => {
  const b = K.normalizeKeybinds({}, 'win32');
  assert.strictEqual(
    K.matchAppKeybind(b, fakeEv({ key: 'ArrowDown', shift: true })),
    'scrollBottom'
  );
  assert.strictEqual(K.matchAppKeybind(b, fakeEv({ key: 'ArrowDown' })), null);
});

test('isReserved detects app shortcuts', () => {
  assert.ok(K.isReserved({ key: 't', meta: true, ctrl: false, alt: false, shift: false }));
  assert.ok(K.isReserved({ key: 'T', meta: true, ctrl: false, alt: false, shift: false }));
  assert.ok(K.isReserved({ key: 'w', meta: false, ctrl: true, alt: false, shift: false }));
  assert.ok(!K.isReserved({ key: 'Enter', meta: true, ctrl: false, alt: false, shift: false }));
});

test('formatChord and chordParts use text modifiers + arrow glyphs', () => {
  assert.strictEqual(K.formatChord(null), 'не задано');
  assert.strictEqual(
    K.formatChord({ key: 'Enter', meta: true, ctrl: false, alt: false, shift: false }, 'darwin'),
    'Cmd+Enter'
  );
  assert.strictEqual(
    K.formatChord({ key: 'ArrowDown', meta: false, ctrl: false, alt: false, shift: true }, 'darwin'),
    'Shift+↓'
  );
  assert.deepStrictEqual(
    K.chordParts({ key: 'Enter', meta: false, ctrl: true, alt: false, shift: false }, 'win32'),
    ['Ctrl', 'Enter']
  );
  assert.deepStrictEqual(
    K.chordParts({ key: 'ArrowLeft', meta: false, ctrl: true, alt: false, shift: true }, 'win32'),
    ['Ctrl', 'Shift', '←']
  );
  assert.strictEqual(
    K.formatChord({ key: 'Home', meta: false, ctrl: false, alt: false, shift: false }, 'win32'),
    'Home'
  );
});

test('chordFromEvent ignores modifier-only keys', () => {
  assert.strictEqual(K.chordFromEvent(fakeEv({ key: 'Meta', meta: true })), null);
  assert.strictEqual(K.chordFromEvent(fakeEv({ key: 'Shift', shift: true })), null);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
