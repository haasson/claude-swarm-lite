// Plain-node tests for the screen scraping helpers used by the status detector.
const assert = require('assert');
const S = require('../screen');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// A permission prompt as Claude Code paints it: framed box, options, hint row,
// and the user's custom statusline pinned to the very bottom.
const PERMISSION = [
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│                                          │',
  '│   rm -rf build/                          │',
  '│                                          │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. Yes, and don\'t ask again            │',
  '│   3. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
  '  Esc to cancel',
  'claude-opus │ ~/proj │ ███░░ 65% │ task',
].join('\n');

test('returns the question line above the options', () => {
  assert.strictEqual(S.extractQuestion(PERMISSION), 'Do you want to proceed?');
});

test('ignores the user statusline at the bottom', () => {
  // The statusline is the LOWEST line on a waiting screen — without the │ / █░
  // check it would be picked as the question.
  const snap = ['│ Какой цвет иконки? │', 'model │ ~/p │ ███░ 65% │ x'].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Какой цвет иконки?');
});

test('ignores frames, blank lines and the bare input box', () => {
  const snap = ['│ Ready to code? │', '╰────────────────╯', '', '> ', ''].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Ready to code?');
});

test('skips option rows even when drawn inside a frame', () => {
  const snap = ['│ Pick one │', '│ ❯ 1. Blue │', '│   2. Grey │'].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Pick one');
});

test('handles plain > and arrow option cursors', () => {
  assert.strictEqual(S.extractQuestion(['Pick one', '> 1. Blue', '  2. Grey'].join('\n')), 'Pick one');
  assert.strictEqual(S.extractQuestion(['Pick one', '▸ 1. Blue', '  2. Grey'].join('\n')), 'Pick one');
});

test('collapses inner whitespace', () => {
  assert.strictEqual(S.extractQuestion('│  Do   you   want?   │'), 'Do you want?');
});

test('truncates long questions to 80 chars with an ellipsis', () => {
  const long = 'x'.repeat(200);
  const out = S.extractQuestion(long);
  assert.strictEqual(out.length, 80);
  assert.ok(out.endsWith('…'));
});

test('returns null when nothing on screen qualifies', () => {
  assert.strictEqual(S.extractQuestion(''), null);
  assert.strictEqual(S.extractQuestion('╰──────╯\n\n> \n'), null);
  assert.strictEqual(S.extractQuestion(null), null);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' screen tests passed');
