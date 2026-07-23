// Plain-node tests for the status state machine + «ждёт» latch (detector.js).
const assert = require('assert');
const D = require('../detector');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = 1_000_000;
const quietAt = () => NOW - D.ACTIVE_MS - 1; // lastDataAt old enough to count as quiet

// Screen fixtures.
const PERMISSION = [
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. No, and tell Claude what to do      │',
  '  Esc to cancel',
].join('\n');
const QUESTION = ['Какой цвет иконки?', '❯ 1. Синий', '  2. Серый'].join('\n');
const ASK = 'Сейчас от тебя: путь к схеме';
const SPINNER = '✻ Cooking… (12s · esc to interrupt)';
const QUIET = '> \n';

function mkD(over) {
  return Object.assign(
    { lastDataAt: quietAt(), waitLatched: false, waitKind: null, chromeGoneSince: 0 },
    over,
  );
}

// --- decide: the raw per-tick read -----------------------------------------

test('decide: permission chrome wins even while bytes flow', () => {
  const r = D.decide(mkD({ lastDataAt: NOW }), NOW, PERMISSION);
  assert.strictEqual(r.status, 'waiting');
  assert.strictEqual(r.kind, 'permission');
});

test('decide: recent bytes with no chrome → running', () => {
  const r = D.decide(mkD({ lastDataAt: NOW }), NOW, QUIET);
  assert.strictEqual(r.status, 'running');
});

test('decide: quiet spinner → running (not a false готов)', () => {
  const r = D.decide(mkD(), NOW, SPINNER);
  assert.strictEqual(r.status, 'running');
});

test('decide: quiet prose question → waiting + question', () => {
  const r = D.decide(mkD(), NOW, ASK);
  assert.strictEqual(r.status, 'waiting');
  assert.strictEqual(r.kind, 'question');
});

test('decide: quiet empty screen → ready', () => {
  assert.strictEqual(D.decide(mkD(), NOW, QUIET).status, 'ready');
});

// --- applyLatch: hold «ждёт» through noise ----------------------------------

test('latch: engages when raw goes waiting', () => {
  const d = mkD();
  const eff = D.applyLatch(d, NOW, PERMISSION, D.decide(d, NOW, PERMISSION));
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'permission');
  assert.strictEqual(d.waitLatched, true);
});

test('latch: holds «ждёт» through a one-tick repaint blip (no chrome, no spinner)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  // Blip: screen momentarily has neither chrome nor spinner, and it's quiet.
  const eff = D.applyLatch(d, NOW, QUIET, D.decide(d, NOW, QUIET));
  assert.strictEqual(eff.status, 'waiting', 'must not flicker to ready');
  assert.strictEqual(d.waitLatched, true);
});

test('latch: a repaint blip then chrome back resets the debounce', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  D.applyLatch(d, NOW, QUIET, D.decide(d, NOW, QUIET));           // blip → chromeGoneSince set
  assert.notStrictEqual(d.chromeGoneSince, 0);
  const eff = D.applyLatch(d, NOW + 300, PERMISSION, D.decide(d, NOW + 300, PERMISSION));
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(d.chromeGoneSince, 0, 'chrome back → debounce cleared');
});

test('latch: releases the instant the spinner returns (agent resumed)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'question' });
  const eff = D.applyLatch(d, NOW, SPINNER, D.decide(d, NOW, SPINNER));
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(d.waitLatched, false);
});

test('latch: releases to ready only after the debounce window (trivial prompt answered, quiet)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  D.applyLatch(d, NOW, QUIET, D.decide(d, NOW, QUIET));           // t0: start debounce, held
  assert.strictEqual(d.waitLatched, true);
  const t1 = NOW + D.LATCH_RELEASE_MS;
  const eff = D.applyLatch(d, t1, QUIET, D.decide(d, t1, QUIET)); // window elapsed → release
  assert.strictEqual(eff.status, 'ready');
  assert.strictEqual(d.waitLatched, false);
});

test('latch: typing keeps the prompt on screen, so it stays «ждёт» (not released by input)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  // A keystroke echoes as recent bytes, but the permission chrome is still there.
  const eff = D.applyLatch(d, NOW, PERMISSION, D.decide(mkD({ lastDataAt: NOW }), NOW, PERMISSION));
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(d.waitLatched, true);
});

test('latch: kind sharpens question → permission', () => {
  const d = mkD();
  D.applyLatch(d, NOW, QUESTION, D.decide(d, NOW, QUESTION));     // latch as question
  assert.strictEqual(d.waitKind, 'question');
  const eff = D.applyLatch(d, NOW + 300, PERMISSION, D.decide(d, NOW + 300, PERMISSION));
  assert.strictEqual(eff.kind, 'permission');
});

test('latch: kind never softens permission → question', () => {
  const d = mkD();
  D.applyLatch(d, NOW, PERMISSION, D.decide(d, NOW, PERMISSION));  // latch as permission
  assert.strictEqual(d.waitKind, 'permission');
  const eff = D.applyLatch(d, NOW + 300, QUESTION, D.decide(d, NOW + 300, QUESTION));
  assert.strictEqual(eff.kind, 'permission');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' detector tests passed');
