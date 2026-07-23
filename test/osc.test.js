// Plain-node tests for the hook-marker parser (osc.js).
const assert = require('assert');
const { extractHookSignals } = require('../osc');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const BEL = '\x07';
const mk = (token, sid) => `\x1b]777;swarm;${token}${sid != null ? ';' + sid : ''}${BEL}`;

test('parses a single marker with a session id', () => {
  const { signals } = extractHookSignals('output' + mk('perm', 'abc123') + 'more');
  assert.deepStrictEqual(signals, [{ token: 'perm', sessionId: 'abc123' }]);
});

test('parses a marker without a session id', () => {
  const { signals } = extractHookSignals(mk('idle'));
  assert.deepStrictEqual(signals, [{ token: 'idle', sessionId: null }]);
});

test('accepts an ST terminator (ESC \\) as well as BEL', () => {
  const { signals } = extractHookSignals('\x1b]777;swarm;busy;s1\x1b\\');
  assert.deepStrictEqual(signals, [{ token: 'busy', sessionId: 's1' }]);
});

test('parses several markers in one chunk', () => {
  const { signals } = extractHookSignals(mk('busy') + 'x' + mk('ask', 'q9'));
  assert.deepStrictEqual(signals, [
    { token: 'busy', sessionId: null },
    { token: 'ask', sessionId: 'q9' },
  ]);
});

test('ignores plain text with no markers', () => {
  const { signals } = extractHookSignals('just terminal output, no markers here');
  assert.strictEqual(signals.length, 0);
});

test('reassembles a marker split across two chunks via the carry', () => {
  const full = 'pre' + mk('perm', 'sess-42') + 'post';
  const cut = full.length - 10;
  const a = extractHookSignals('' + full.slice(0, cut));
  assert.strictEqual(a.signals.length, 0, 'the split marker is not complete yet');
  const b = extractHookSignals(a.rest + full.slice(cut));
  assert.deepStrictEqual(b.signals, [{ token: 'perm', sessionId: 'sess-42' }]);
});

test('does not re-emit an already-parsed marker on the next chunk', () => {
  const a = extractHookSignals(mk('idle') + 'tail');
  assert.strictEqual(a.signals.length, 1);
  const b = extractHookSignals(a.rest + ' and more plain output');
  assert.strictEqual(b.signals.length, 0);
});

test('caps the carried tail so non-marker output cannot grow unbounded', () => {
  const { rest } = extractHookSignals('z'.repeat(5000));
  assert.ok(rest.length <= 128, 'carry is capped');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' osc tests passed');
