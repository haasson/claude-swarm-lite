// Unit tests for the diff parser / tree builder (no framework: run node test/diff.test.js).
const assert = require('assert');
const D = require('../renderer/diffview');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('formatCount renders both sides', () => {
  assert.deepStrictEqual(D.formatCount({ added: 120, removed: 30 }), { added: '+120', removed: '−30' });
});

test('formatCount omits a zero side', () => {
  assert.deepStrictEqual(D.formatCount({ added: 5, removed: 0 }), { added: '+5', removed: '' });
  assert.deepStrictEqual(D.formatCount({ added: 0, removed: 7 }), { added: '', removed: '−7' });
});

test('formatCount of nothing is empty', () => {
  assert.deepStrictEqual(D.formatCount({ added: 0, removed: 0 }), { added: '', removed: '' });
});

test('parseNumstatZ reads a plain modification', () => {
  assert.deepStrictEqual(D.parseNumstatZ('80\t12\tgit.js\0'), [
    { path: 'git.js', oldPath: null, added: 80, removed: 12, status: 'modified', binary: false },
  ]);
});

test('parseNumstatZ reads several records', () => {
  const out = D.parseNumstatZ('80\t12\tgit.js\0005\t0\tmain.js\0');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].path, 'main.js');
  assert.strictEqual(out[1].added, 5);
});

test('parseNumstatZ marks a binary file instead of yielding NaN', () => {
  const [f] = D.parseNumstatZ('-\t-\tbuild/icon.png\0');
  assert.strictEqual(f.binary, true);
  assert.strictEqual(f.status, 'binary');
  assert.strictEqual(f.added, 0);   // never NaN — the bar would render "+NaN"
  assert.strictEqual(f.removed, 0);
});

test('parseNumstatZ reads a rename as old + new paths', () => {
  const [f] = D.parseNumstatZ('3\t1\t\0old/a.js\0new/b.js\0');
  assert.strictEqual(f.status, 'renamed');
  assert.strictEqual(f.oldPath, 'old/a.js');
  assert.strictEqual(f.path, 'new/b.js');
  assert.strictEqual(f.added, 3);
});

test('parseNumstatZ keeps unicode and spaced paths intact', () => {
  const [f] = D.parseNumstatZ('1\t0\tдоки/мой файл.md\0');
  assert.strictEqual(f.path, 'доки/мой файл.md');
});

test('parseNumstatZ of empty output is an empty list', () => {
  assert.deepStrictEqual(D.parseNumstatZ(''), []);
  assert.deepStrictEqual(D.parseNumstatZ('\0'), []);
});

const SIMPLE = [
  'diff --git a/git.js b/git.js',
  'index 1111111..2222222 100644',
  '--- a/git.js',
  '+++ b/git.js',
  '@@ -10,4 +10,5 @@ function runGit() {',
  '   const x = 1;',
  '-  const old = 2;',
  '+  const neu = 2;',
  '+  const extra = 3;',
  '   return x;',
  '',
].join('\n');

test('parseUnified returns one hunk with typed lines', () => {
  const hunks = D.parseUnified(SIMPLE);
  assert.strictEqual(hunks.length, 1);
  assert.strictEqual(hunks[0].header, '@@ -10,4 +10,5 @@ function runGit() {');
  assert.deepStrictEqual(hunks[0].lines.map((l) => l.type), ['ctx', 'del', 'add', 'add', 'ctx']);
  assert.strictEqual(hunks[0].lines[1].text, '  const old = 2;');
});

test('parseUnified numbers old and new lines independently', () => {
  const [h] = D.parseUnified(SIMPLE);
  // ctx 10/10 | del 11/- | add -/11 | add -/12 | ctx 12/13
  assert.deepStrictEqual(h.lines.map((l) => [l.oldNo, l.newNo]), [
    [10, 10], [11, null], [null, 11], [null, 12], [12, 13],
  ]);
});

test('parseUnified handles several hunks in one file', () => {
  const text = [
    '@@ -1,2 +1,2 @@', ' a', '-b', '+B',
    '@@ -50,2 +50,2 @@', ' c', '-d', '+D', '',
  ].join('\n');
  const hunks = D.parseUnified(text);
  assert.strictEqual(hunks.length, 2);
  assert.strictEqual(hunks[1].lines[0].oldNo, 50);
});

test('parseUnified treats "\\ No newline at end of file" as meta, not context', () => {
  const text = ['@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+b', ''].join('\n');
  const [h] = D.parseUnified(text);
  assert.deepStrictEqual(h.lines.map((l) => l.type), ['del', 'meta', 'add']);
  // the meta marker must not consume a line number
  assert.strictEqual(h.lines[2].newNo, 1);
});

test('parseUnified strips CR so CRLF diffs do not leak \\r into the DOM', () => {
  const [h] = D.parseUnified('@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n');
  assert.strictEqual(h.lines[0].text, 'a');
  assert.strictEqual(h.lines[1].text, 'b');
});

test('parseUnified of a fully deleted file is all removals', () => {
  const text = ['@@ -1,3 +0,0 @@', '-a', '-b', '-c', ''].join('\n');
  const [h] = D.parseUnified(text);
  assert.deepStrictEqual(h.lines.map((l) => l.type), ['del', 'del', 'del']);
  assert.deepStrictEqual(h.lines.map((l) => l.newNo), [null, null, null]);
});

test('parseUnified of an empty or headers-only diff is an empty list', () => {
  assert.deepStrictEqual(D.parseUnified(''), []);
  assert.deepStrictEqual(D.parseUnified('diff --git a/x b/x\n--- a/x\n+++ b/x\n'), []);
});

test('buildTree nests files under their folders', () => {
  const tree = D.buildTree([
    { path: 'renderer/renderer.js', added: 80, removed: 12 },
    { path: 'renderer/diffview.js', added: 120, removed: 0 },
    { path: 'git.js', added: 40, removed: 8 },
  ]);
  assert.deepStrictEqual(tree.map((n) => [n.kind, n.name]), [
    ['dir', 'renderer'],
    ['file', 'git.js'],
  ]);
  assert.deepStrictEqual(tree[0].children.map((n) => n.name), ['renderer.js', 'diffview.js']);
});

test('buildTree sums counts up into folder nodes', () => {
  const tree = D.buildTree([
    { path: 'a/b/x.js', added: 3, removed: 1 },
    { path: 'a/b/y.js', added: 4, removed: 2 },
  ]);
  assert.strictEqual(tree[0].name, 'a');
  assert.strictEqual(tree[0].added, 7);
  assert.strictEqual(tree[0].removed, 3);
  assert.strictEqual(tree[0].children[0].name, 'b');
  assert.strictEqual(tree[0].children[0].added, 7);
});

test('buildTree keeps folders before root files', () => {
  const tree = D.buildTree([
    { path: 'zz.js', added: 1, removed: 0 },
    { path: 'aa/deep.js', added: 1, removed: 0 },
  ]);
  assert.deepStrictEqual(tree.map((n) => n.kind), ['dir', 'file']);
});

test('buildTree carries the file payload on the leaf', () => {
  const file = { path: 'a/x.js', added: 1, removed: 0, status: 'renamed', oldPath: 'a/old.js' };
  const [dir] = D.buildTree([file]);
  assert.strictEqual(dir.children[0].file, file);
  assert.strictEqual(dir.children[0].file.status, 'renamed');
});

test('buildTree of a single root file is one leaf', () => {
  const tree = D.buildTree([{ path: 'x.js', added: 1, removed: 0 }]);
  assert.deepStrictEqual(tree.map((n) => [n.kind, n.name]), [['file', 'x.js']]);
});

test('buildTree of nothing is empty', () => {
  assert.deepStrictEqual(D.buildTree([]), []);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
