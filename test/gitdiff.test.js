// Unit tests for git.js' pure untracked-file helpers (run node test/gitdiff.test.js).
// The git-calling functions are not covered here: they need a real repo. These
// two are pure buffer math, which is where the NaN/binary bugs actually live.
const assert = require('assert');
const G = require('../git');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('isBinaryBuffer spots a NUL byte', () => {
  assert.strictEqual(G.isBinaryBuffer(Buffer.from([0x61, 0x00, 0x62])), true);
});

test('isBinaryBuffer passes plain text, including unicode', () => {
  assert.strictEqual(G.isBinaryBuffer(Buffer.from('const x = 1;\nпривет\n', 'utf8')), false);
});

test('isBinaryBuffer only sniffs the first 8KB', () => {
  const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
  assert.strictEqual(G.isBinaryBuffer(buf), false); // NUL sits past the sniff window
});

test('isBinaryBuffer treats an empty buffer as text', () => {
  assert.strictEqual(G.isBinaryBuffer(Buffer.alloc(0)), false);
});

test('countLines counts newline-terminated lines', () => {
  assert.strictEqual(G.countLines(Buffer.from('a\nb\nc\n', 'utf8')), 3);
});

test('countLines counts a last line with no trailing newline', () => {
  assert.strictEqual(G.countLines(Buffer.from('a\nb\nc', 'utf8')), 3);
});

test('countLines handles CRLF without double-counting', () => {
  assert.strictEqual(G.countLines(Buffer.from('a\r\nb\r\n', 'utf8')), 2);
});

test('countLines of an empty file is 0', () => {
  assert.strictEqual(G.countLines(Buffer.alloc(0)), 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
