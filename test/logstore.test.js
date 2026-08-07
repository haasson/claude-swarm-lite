// Unit tests for the in-app log ring buffer (no framework: run node test/logstore.test.js).
const assert = require('assert');
const { createLogStore } = require('../renderer/logstore');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('push records an entry and grows size', () => {
  const s = createLogStore(10);
  s.push({ ts: '00:00:01', source: 'ui', level: 'error', msg: 'boom' });
  assert.strictEqual(s.size(), 1);
  assert.strictEqual(s.entries()[0].msg, 'boom');
});

test('errorCount counts only error-level entries', () => {
  const s = createLogStore(10);
  s.push({ level: 'error', msg: 'a' });
  s.push({ level: 'warn', msg: 'b' });
  s.push({ level: 'error', msg: 'c' });
  assert.strictEqual(s.errorCount(), 2);
  assert.strictEqual(s.size(), 3);
});

test('ring buffer drops the oldest past cap and keeps errorCount honest', () => {
  const s = createLogStore(2);
  s.push({ level: 'error', msg: '1' });
  s.push({ level: 'error', msg: '2' });
  s.push({ level: 'warn', msg: '3' }); // evicts '1' (an error)
  assert.strictEqual(s.size(), 2);
  assert.strictEqual(s.errorCount(), 1);
  assert.deepStrictEqual(s.entries().map((e) => e.msg), ['2', '3']);
});

test('push coerces missing fields and stringifies msg', () => {
  const s = createLogStore(10);
  const e = s.push({ msg: 42 });
  assert.strictEqual(e.msg, '42');
  assert.strictEqual(e.level, 'error'); // default
  assert.strictEqual(e.source, 'ui');   // default
});

test('text() renders a copyable multiline dump', () => {
  const s = createLogStore(10);
  s.push({ ts: 't1', source: 'ui', level: 'error', msg: 'x' });
  s.push({ ts: 't2', source: 'main', level: 'warn', msg: 'y' });
  assert.strictEqual(s.text(), '[t1] ui/error: x\n[t2] main/warn: y');
});

test('clear() resets entries and errorCount', () => {
  const s = createLogStore(10);
  s.push({ level: 'error', msg: 'a' });
  s.clear();
  assert.strictEqual(s.size(), 0);
  assert.strictEqual(s.errorCount(), 0);
  assert.strictEqual(s.unseenCount(), 0);
});

test('markSeen() гасит счётчик, а новая ошибка зажигает его снова', () => {
  const s = createLogStore(10);
  s.push({ level: 'error', msg: 'a' });
  s.push({ level: 'warn', msg: 'w' });   // предупреждения счётчик не зажигают
  assert.strictEqual(s.unseenCount(), 1);
  s.markSeen();
  assert.strictEqual(s.unseenCount(), 0);
  assert.strictEqual(s.errorCount(), 1); // сама запись осталась в логе
  s.push({ level: 'error', msg: 'b' });
  assert.strictEqual(s.unseenCount(), 1);
});

test('вытеснение из кольца не оставляет непрочитанных больше, чем ошибок', () => {
  const s = createLogStore(2);
  s.push({ level: 'error', msg: '1' });
  s.push({ level: 'error', msg: '2' });
  s.push({ level: 'warn', msg: '3' });   // вытесняет ошибку '1'
  assert.strictEqual(s.errorCount(), 1);
  assert.strictEqual(s.unseenCount(), 1);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
