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

// --- inferWaitingKind: разрешение vs вопрос ---------------------------------
// Only meaningful once the detector already decided «waiting»; it labels WHY.

test('permission chrome → permission', () => {
  // The PERMISSION fixture has numbered options too, but the permission phrasing
  // must win — so it's «разрешение», not «вопрос».
  assert.strictEqual(S.inferWaitingKind(PERMISSION), 'permission');
});

test('"Do you want" alone → permission', () => {
  const snap = ['│ Do you want to make this edit? │', '│ ❯ 1. Yes │', '│   2. No │'].join('\n');
  assert.strictEqual(S.inferWaitingKind(snap), 'permission');
});

test('numbered question without permission phrasing → question', () => {
  const snap = [
    'Какой цвет иконки?',
    '❯ 1. Синий',
    '  2. Серый',
    'model │ ~/p │ ██░ 40%',
  ].join('\n');
  assert.strictEqual(S.inferWaitingKind(snap), 'question');
});

test('plain > and arrow option cursors → question', () => {
  assert.strictEqual(S.inferWaitingKind(['Pick one', '> 1. Blue', '  2. Grey'].join('\n')), 'question');
  assert.strictEqual(S.inferWaitingKind(['Pick one', '▸ 1. Blue', '  2. Grey'].join('\n')), 'question');
});

test('«Сейчас от тебя» prose question → question', () => {
  assert.strictEqual(S.inferWaitingKind('Сейчас от тебя: путь к схеме'), 'question');
});

test('«Сейчас от тебя: ничего, жди …» is NOT a request', () => {
  assert.strictEqual(S.asksForInput('Сейчас от тебя: ничего, жди результата ревью'), false);
  assert.strictEqual(S.asksForInput('Сейчас от тебя — ничего не нужно'), false);
  assert.strictEqual(S.asksForInput('Сейчас от тебя: подожди, пока соберётся билд'), false);
  assert.strictEqual(S.asksForInput('Сейчас от тебя: жди'), false);
});

test('«Сейчас от тебя: <настоящий запрос>» IS a request', () => {
  assert.strictEqual(S.asksForInput('Сейчас от тебя: путь к схеме'), true);
  assert.strictEqual(S.asksForInput('Сейчас от тебя: подтверди, ничего не удаляй'), true);
  assert.strictEqual(S.asksForInput('обычный вывод без маркера'), false);
});

test('a «ничего, жди» sign-off does NOT classify as question via the marker', () => {
  // extractQuestion may still pick the line, but the ask-marker path must not fire.
  assert.strictEqual(S.asksForInput('Сейчас от тебя: ничего, жди результата ревью'), false);
});

test('a bare prose question line → question', () => {
  assert.strictEqual(S.inferWaitingKind(['│ Какой выбрать вариант? │', 'model │ ~/p │ ██░ 40%'].join('\n')), 'question');
});

test('quiet screen with nothing to ask → null (generic «ждёт»)', () => {
  assert.strictEqual(S.inferWaitingKind('>\n'), null);
  assert.strictEqual(S.inferWaitingKind(''), null);
  assert.strictEqual(S.inferWaitingKind(null), null);
});

// The sub-agent status line Claude pins above the input box (real capture). It
// stays whether the main turn is busy or the prompt is idle.
const WAITING4 = [
  '✻ Waiting for 4 background agents to finish',
  '─────────────────────────────────────────',
  '❯ ',
  '─────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · ↓ to manage',
  '',
  '  ⏺ main',
  '  ◯ Explore  Long probe A: status detector          2m 2s · ↓ 28.4k tokens',
  '  ◯ Explore  Long probe B: renderer status flow     1m 59s · ↓ 28.7k tokens',
  '  ◯ Explore  Long probe C: settings UI              1m 55s · ↓ 39.1k tokens',
  '  ◯ Explore  Long probe D: tabstyle model           1m 50s · ↓ 23.8k tokens',
].join('\n');

test('countSubagents reads the "Waiting for N" count', () => {
  assert.strictEqual(S.countSubagents(WAITING4), 4);
});

test('countSubagents handles the singular "1 background agent"', () => {
  assert.strictEqual(S.countSubagents('✻ Waiting for 1 background agent to finish'), 1);
});

test('countSubagents returns 0 when no sub-agents are on screen', () => {
  assert.strictEqual(S.countSubagents(PERMISSION), 0);
  assert.strictEqual(S.countSubagents(''), 0);
  assert.strictEqual(S.countSubagents(null), 0);
});

test('countSubagents falls back to counting hollow-circle roster rows', () => {
  // No "Waiting for N" line (roster shown without it): count only running rows.
  const roster = [
    '  ⏺ main',
    '  ◯ Explore  probe A   19s · ↓ 9.3k tokens',
    '  ◯ Plan     probe B   15s · ↓ 11.5k tokens',
    '  ⏺ Explore  probe C   Done (12 tool uses · 8k tokens · 40s)', // finished — filled, not counted
  ].join('\n');
  assert.strictEqual(S.countSubagents(roster), 2);
});

// A minimal stand-in for an xterm buffer: rows of text, plus the blank tail a
// shrinking TUI frame leaves behind (see snapshotRows in screen.js).
function fakeBuf(rows) {
  return {
    length: rows.length,
    getLine: (y) => (rows[y] == null ? null : { translateToString: () => rows[y] }),
  };
}

test('contentEnd ignores blank rows below the screen content', () => {
  assert.strictEqual(S.contentEnd(fakeBuf(['a', 'b', '', '   ', ''])), 2);
  assert.strictEqual(S.contentEnd(fakeBuf(['a', 'b'])), 2);
  assert.strictEqual(S.contentEnd(fakeBuf(['', '  '])), 0);
  assert.strictEqual(S.contentEnd(fakeBuf([])), 0);
});

test('snapshotRows takes the last rows WITH content, not the last rows of the buffer', () => {
  const rows = ['вопрос', 'хвост', '', '', '', ''];   // 4 blank rows below the content
  assert.strictEqual(S.snapshotRows(fakeBuf(rows), 2), 'вопрос\nхвост');
  // Fewer rows of content than asked for: return what there is, no padding.
  assert.strictEqual(S.snapshotRows(fakeBuf(rows), 16), 'вопрос\nхвост');
});

test('snapshotRows keeps blank rows that sit BETWEEN content', () => {
  assert.strictEqual(S.snapshotRows(fakeBuf(['a', '', 'b', '']), 16), 'a\n\nb');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' screen tests passed');
