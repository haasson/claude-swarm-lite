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

test('ACTIONS has chord + two scopes', () => {
  assert.strictEqual(K.ACTIONS.length, 3);
  const ids = K.ACTIONS.map((a) => a.id);
  assert.deepStrictEqual(ids, ['newline', 'word', 'line']);
  assert.strictEqual(K.ACTIONS.find((a) => a.id === 'newline').kind, 'chord');
  assert.strictEqual(K.ACTIONS.find((a) => a.id === 'word').kind, 'scope');
  assert.strictEqual(K.ACTIONS.find((a) => a.id === 'line').kind, 'scope');
});

test('BYTES cover move and delete for word and line', () => {
  assert.strictEqual(K.BYTES.newline, '\n');
  assert.strictEqual(K.BYTES.wordLeft, '\x1bb');
  assert.strictEqual(K.BYTES.wordRight, '\x1bf');
  assert.strictEqual(K.BYTES.wordBackspace, '\x1b\x7f');
  assert.strictEqual(K.BYTES.wordDelete, '\x1bd');
  assert.strictEqual(K.BYTES.lineStart, '\x01');
  assert.strictEqual(K.BYTES.lineEnd, '\x05');
  assert.strictEqual(K.BYTES.lineBackspace, '\x15');
  assert.strictEqual(K.BYTES.lineDelete, '\x0b');
});

test('normalizeKeybinds fills darwin defaults from empty/garbage', () => {
  const b = K.normalizeKeybinds(null, 'darwin');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_DARWIN.newline);
  assert.deepStrictEqual(b.word, K.DEFAULT_KEYBINDS_DARWIN.word);
  assert.deepStrictEqual(b.line, K.DEFAULT_KEYBINDS_DARWIN.line);
  const g = K.normalizeKeybinds('nope', 'darwin');
  assert.deepStrictEqual(g.word, K.DEFAULT_KEYBINDS_DARWIN.word);
});

test('normalizeKeybinds fills win defaults (Ctrl word / Alt line)', () => {
  const b = K.normalizeKeybinds(null, 'win32');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_WIN.newline);
  assert.deepStrictEqual(b.word, K.DEFAULT_KEYBINDS_WIN.word);
  assert.deepStrictEqual(b.line, K.DEFAULT_KEYBINDS_WIN.line);
  assert.strictEqual(b.newline.ctrl, true);
  assert.strictEqual(b.newline.meta, false);
  assert.strictEqual(b.word.ctrl, true);
  assert.strictEqual(b.line.alt, true);
});

test('normalizeKeybinds migrates leftover mac defaults on win32', () => {
  const b = K.normalizeKeybinds({
    newline: { key: 'Enter', meta: true, ctrl: false, alt: false, shift: false },
    word: { meta: true, ctrl: false, alt: false, shift: false },
    line: { meta: false, ctrl: true, alt: false, shift: false },
  }, 'win32');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_WIN.newline);
  assert.deepStrictEqual(b.word, K.DEFAULT_KEYBINDS_WIN.word);
  assert.deepStrictEqual(b.line, K.DEFAULT_KEYBINDS_WIN.line);
});

test('normalizeKeybinds migrates legacy wordLeft/lineStart chords', () => {
  const b = K.normalizeKeybinds({
    newline: { key: 'Enter', meta: true, ctrl: false, alt: false, shift: false },
    wordLeft: { key: 'ArrowLeft', meta: true, ctrl: false, alt: false, shift: false },
    lineStart: { key: 'ArrowLeft', meta: false, ctrl: true, alt: false, shift: false },
  }, 'darwin');
  assert.deepStrictEqual(b.word, { meta: true, ctrl: false, alt: false, shift: false });
  assert.deepStrictEqual(b.line, { meta: false, ctrl: true, alt: false, shift: false });
  assert.strictEqual(b.scrollBottom, undefined);
  assert.strictEqual(b.wordLeft, undefined);
});

test('normalizeKeybinds Home-only legacy line on win32 → Alt default', () => {
  const b = K.normalizeKeybinds({
    wordLeft: { key: 'ArrowLeft', meta: false, ctrl: true, alt: false, shift: false },
    lineStart: { key: 'Home', meta: false, ctrl: false, alt: false, shift: false },
  }, 'win32');
  assert.deepStrictEqual(b.word, K.DEFAULT_KEYBINDS_WIN.word);
  assert.deepStrictEqual(b.line, K.DEFAULT_KEYBINDS_WIN.line);
});

test('normalizeKeybinds keeps explicit null (cleared binding)', () => {
  const b = K.normalizeKeybinds({ newline: null }, 'darwin');
  assert.strictEqual(b.newline, null);
  assert.deepStrictEqual(b.word, K.DEFAULT_KEYBINDS_DARWIN.word);
});

test('normalizeKeybinds rejects reserved chords and falls back to default', () => {
  const b = K.normalizeKeybinds({
    newline: { key: 't', meta: true, ctrl: false, alt: false, shift: false },
  }, 'darwin');
  assert.deepStrictEqual(b.newline, K.DEFAULT_KEYBINDS_DARWIN.newline);
});

test('normalizeKeybinds accepts a custom valid chord and scopes', () => {
  const chord = { key: 'Enter', meta: false, ctrl: false, alt: false, shift: true };
  const word = { meta: false, ctrl: false, alt: true, shift: false };
  const line = { meta: false, ctrl: false, alt: false, shift: true };
  const b = K.normalizeKeybinds({ newline: chord, word, line }, 'win32');
  assert.deepStrictEqual(b.newline, chord);
  assert.deepStrictEqual(b.word, word);
  assert.deepStrictEqual(b.line, line);
});

test('normalizeKeybinds resets colliding scopes', () => {
  const same = { meta: true, ctrl: false, alt: false, shift: false };
  const b = K.normalizeKeybinds({ word: same, line: same }, 'darwin');
  assert.deepStrictEqual(b.word, same);
  assert.deepStrictEqual(b.line, K.DEFAULT_KEYBINDS_DARWIN.line);
  assert.ok(!K.modsEqual(b.word, b.line));
});

test('chordMatches Meta+Enter for darwin newline default', () => {
  const b = K.normalizeKeybinds({}, 'darwin');
  assert.ok(K.chordMatches(b.newline, fakeEv({ key: 'Enter', meta: true })));
  assert.ok(!K.chordMatches(b.newline, fakeEv({ key: 'Enter' })));
});

test('matchInputBytes: Cmd+arrows / Backspace / Delete (darwin word)', () => {
  const b = K.normalizeKeybinds({}, 'darwin');
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'ArrowLeft', meta: true })),
    K.BYTES.wordLeft
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'ArrowRight', meta: true })),
    K.BYTES.wordRight
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'Backspace', meta: true })),
    K.BYTES.wordBackspace
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'Delete', meta: true })),
    K.BYTES.wordDelete
  );
});

test('matchInputBytes: Ctrl+arrows / Backspace / Delete (darwin line)', () => {
  const b = K.normalizeKeybinds({}, 'darwin');
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'ArrowLeft', ctrl: true })),
    K.BYTES.lineStart
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'ArrowRight', ctrl: true })),
    K.BYTES.lineEnd
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'Backspace', ctrl: true })),
    K.BYTES.lineBackspace
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'Delete', ctrl: true })),
    K.BYTES.lineDelete
  );
});

test('matchInputBytes: newline chord and passthrough', () => {
  const b = K.normalizeKeybinds({}, 'darwin');
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'Enter', meta: true })),
    '\n'
  );
  assert.strictEqual(K.matchInputBytes(b, fakeEv({ key: 'a' })), null);
  assert.strictEqual(K.matchInputBytes(b, fakeEv({ key: 'ArrowLeft' })), null);
});

test('matchInputBytes uses Ctrl word / Alt line on win32', () => {
  const b = K.normalizeKeybinds({}, 'win32');
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'Enter', ctrl: true })),
    '\n'
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'ArrowLeft', ctrl: true })),
    K.BYTES.wordLeft
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'ArrowRight', alt: true })),
    K.BYTES.lineEnd
  );
  assert.strictEqual(
    K.matchInputBytes(b, fakeEv({ key: 'Home' })),
    null
  );
});

test('matchInputKeybind only matches chord actions', () => {
  const b = K.normalizeKeybinds({}, 'darwin');
  assert.strictEqual(
    K.matchInputKeybind(b, fakeEv({ key: 'Enter', meta: true })),
    'newline'
  );
  assert.strictEqual(
    K.matchInputKeybind(b, fakeEv({ key: 'ArrowLeft', meta: true })),
    null
  );
});

test('isReserved detects app shortcuts', () => {
  assert.ok(K.isReserved({ key: 't', meta: true, ctrl: false, alt: false, shift: false }));
  assert.ok(K.isReserved({ key: 'T', meta: true, ctrl: false, alt: false, shift: false }));
  assert.ok(K.isReserved({ key: 'w', meta: false, ctrl: true, alt: false, shift: false }));
  assert.ok(!K.isReserved({ key: 'Enter', meta: true, ctrl: false, alt: false, shift: false }));
});

test('formatChord / formatScope / bindingParts', () => {
  assert.strictEqual(K.formatChord(null), 'не задано');
  assert.strictEqual(K.formatScope(null), 'не задано');
  assert.strictEqual(
    K.formatChord({ key: 'Enter', meta: true, ctrl: false, alt: false, shift: false }, 'darwin'),
    'Cmd+Enter'
  );
  assert.strictEqual(
    K.formatScope({ meta: true, ctrl: false, alt: false, shift: false }, 'darwin'),
    'Cmd'
  );
  assert.strictEqual(
    K.formatScope({ meta: false, ctrl: true, alt: false, shift: false }, 'darwin'),
    'Ctrl'
  );
  assert.deepStrictEqual(
    K.scopeParts({ meta: false, ctrl: true, alt: false, shift: false }, 'win32'),
    ['Ctrl']
  );
  assert.deepStrictEqual(
    K.bindingParts('word', { meta: true, ctrl: false, alt: false, shift: false }, 'darwin'),
    ['Cmd']
  );
  assert.deepStrictEqual(
    K.bindingParts('newline', { key: 'Enter', meta: false, ctrl: true, alt: false, shift: false }, 'win32'),
    ['Ctrl', 'Enter']
  );
});

test('chordFromEvent ignores modifier-only; scopeFromEvent accepts them', () => {
  assert.strictEqual(K.chordFromEvent(fakeEv({ key: 'Meta', meta: true })), null);
  assert.strictEqual(K.chordFromEvent(fakeEv({ key: 'Shift', shift: true })), null);
  assert.deepStrictEqual(
    K.scopeFromEvent(fakeEv({ key: 'Meta', meta: true })),
    { meta: true, ctrl: false, alt: false, shift: false }
  );
  assert.deepStrictEqual(
    K.scopeFromEvent(fakeEv({ key: 'a', meta: true })),
    { meta: true, ctrl: false, alt: false, shift: false }
  );
  assert.strictEqual(K.scopeFromEvent(fakeEv({ key: 'a' })), null);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
