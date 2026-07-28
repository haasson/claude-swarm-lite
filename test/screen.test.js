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

// --- the input box's own furniture is not a question --------------------------
// Straight from a live run: this is what got sent to Telegram as «❓ вопрос».

test('extractQuestion skips the mode line under the input box', () => {
  const snap = [
    'Сейчас от тебя: катать миграцию сразу или ждать релиза?',
    '',
    '> ',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
  ].join('\n');
  assert.strictEqual(S.extractQuestion(snap), 'Сейчас от тебя: катать миграцию сразу или ждать релиза?');
});

test('extractQuestion skips the rest of Claude Code chrome', () => {
  for (const junk of [
    '⏵⏵ accept edits on (shift+tab to cycle)',
    '⏸ plan mode on (shift+tab to cycle)',
    '? for shortcuts',
    'Context left until auto-compact: 25%',
    'esc to interrupt',
    'ctrl+r to expand',
    '✻ Cooking… (12s · esc to interrupt)',
  ]) {
    assert.strictEqual(S.extractQuestion('Какой вариант берём?\n' + junk), 'Какой вариант берём?', junk);
  }
});

test('extractQuestion returns null rather than chrome when there is no prose', () => {
  assert.strictEqual(S.extractQuestion('> \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'), null);
});

// --- parsePrompt: the prompt box as something answerable from a phone ---------

const PERM = [
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│ rm -rf build                             │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. Yes, and don\'t ask again            │',
  '│   3. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
  '  Esc to cancel',
].join('\n');

// НАСТОЯЩИЙ экран Claude Code 2.1.220, снятый с живого TUI (pty + xterm), а не придуманный.
// Фикстура выше (PERM) — в рамке, и ровно поэтому тесты были зелёными, пока бот в бою
// отвечал «вариантов не разобрал» на КАЖДЫЙ запрос разрешения: настоящий диалог рисуется
// без вертикальной рамки, только горизонтальными линейками, а парсер требовал рамку.
const PERM_REAL_EDIT = [
  '❯ Создай файл zametka.txt со словом привет. Только это, без объяснений.                             ',
  '',
  '⏺ Write(zametka.txt)',
  '',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' Create file',
  ' zametka.txt',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '  1 привет',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to create zametka.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

// Второй настоящий: «доверяешь ли папке» на первом запуске в новой папке. Тоже без рамки.
const PERM_REAL_TRUST = [
  ' Claude Code\'ll be able to read, edit, and execute files here.',
  '',
  ' Security guide',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

test('parsePrompt разбирает НАСТОЯЩИЙ запрос разрешения (без рамки, с линейками)', () => {
  const p = S.parsePrompt(PERM_REAL_EDIT);
  assert.ok(p, 'настоящий диалог обязан разбираться — иначе кнопок нет вообще');
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.strictEqual(p.options[0].text, 'Yes');
  assert.strictEqual(p.options[2].text, 'No');
  // Заголовок — вопрос, а НЕ строки диффа над ним: «1 привет» не должно уехать в кнопку.
  assert.strictEqual(p.title, 'Do you want to create zametka.txt?');
  assert.ok(!/привет/.test(p.title), 'содержимое файла не заголовок: ' + p.title);
  assert.ok(!/Tab to amend/.test(p.title), 'подсказка не заголовок: ' + p.title);
});

test('parsePrompt разбирает НАСТОЯЩИЙ вопрос про доверие папке', () => {
  const p = S.parsePrompt(PERM_REAL_TRUST);
  assert.ok(p, 'диалог доверия тоже отвечается номером');
  assert.deepStrictEqual(p.options.map((o) => o.text), ['Yes, I trust this folder', 'No, exit']);
});

test('parsePrompt returns every option Claude offered, numbered', () => {
  const p = S.parsePrompt(PERM);
  assert.deepStrictEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.strictEqual(p.options[0].text, 'Yes');
  assert.strictEqual(p.options[2].text, 'No, and tell Claude what to do');
});

test('parsePrompt keeps the command being approved in the title', () => {
  const p = S.parsePrompt(PERM);
  assert.ok(p.title.includes('rm -rf build'), p.title);
  assert.ok(p.title.includes('Do you want to proceed?'), p.title);
  assert.ok(!/Esc to cancel/.test(p.title), 'chrome must not leak into the title');
});

test('parsePrompt НЕ берёт нумерованный список из прозы над запросом', () => {
  // Ровно то, что нашло ревью: кнопка «1. переписать модуль оплаты» печатала бы «1»
  // в диалог ниже, то есть одобряла бы rm -rf build.
  const snap = [
    'Предлагаю план:',
    '1. переписать модуль оплаты',
    '2. удалить старый клиент',
    '╭──────────────────────────────────────────╮',
    '│ Bash command                             │',
    '│ rm -rf build                             │',
    '│ Do you want to proceed?                  │',
    '│ ❯ 1. Yes                                 │',
    '│   2. No, and tell Claude what to do      │',
    '╰──────────────────────────────────────────╯',
  ].join('\n');
  const p = S.parsePrompt(snap);
  assert.deepStrictEqual(p.options.map((o) => o.text), ['Yes', 'No, and tell Claude what to do']);
  assert.ok(p.title.includes('rm -rf build'), 'команда обязана быть в тексте: ' + p.title);
  assert.ok(!/переписать/.test(p.title), 'проза не должна попадать в заголовок');
});

test('parsePrompt игнорирует список без рамки — это не запрос', () => {
  assert.strictEqual(S.parsePrompt('Варианты:\n1. один\n2. два\n> '), null);
});

test('parsePrompt требует нумерацию с 1 без дублей', () => {
  const snap = ['│ Do you want to proceed? │', '│ 2. Yes │', '│ 2. No │'].join('\n');
  assert.strictEqual(S.parsePrompt(snap), null);
});

test('parsePrompt says null when there is no choice on screen', () => {
  assert.strictEqual(S.parsePrompt('Просто текст\n> '), null);
  assert.strictEqual(S.parsePrompt('❯ 1. Yes'), null, 'a single option is not a choice');
  assert.strictEqual(S.parsePrompt(''), null);
});

test('parsePrompt fingerprint changes with the prompt, not with its repaint', () => {
  const a = S.parsePrompt(PERM).fingerprint;
  // Same prompt, redrawn with the cursor on another option and different padding.
  const redrawn = PERM.replace('❯ 1. Yes', '  1. Yes').replace('  2. Yes', '❯ 2. Yes');
  assert.strictEqual(S.parsePrompt(redrawn).fingerprint, a, 'a repaint is not a new request');
  const other = PERM.replace('rm -rf build', 'rm -rf /');
  assert.notStrictEqual(S.parsePrompt(other).fingerprint, a, 'another command IS a new request');
});

test('parsePrompt caps a long option label so it fits a button', () => {
  const long = PERM.replace('2. Yes, and don\'t ask again', '2. ' + 'да '.repeat(60));
  const opt = S.parsePrompt(long).options.find((o) => o.n === 2);
  assert.ok(opt.text.length <= 58, opt.text.length);
  assert.ok(opt.text.endsWith('…'));
});

// Runs LAST: it swaps the module-level matcher, and restores it at the end.
test('setAskPhrases swaps the marker the scraper looks for', () => {
  try {
    S.setAskPhrases(['Жду твоего слова']);
    assert.strictEqual(S.asksForInput('Жду твоего слова по деплою'), true);
    assert.strictEqual(S.asksForInput('Сейчас от тебя: путь'), false, 'default is no longer active');
    assert.strictEqual(S.inferWaitingKind('Жду твоего слова'), 'question');
    assert.strictEqual(S.asksForInput('Жду твоего слова: ничего, жди'), false);
  } finally {
    S.setAskPhrases([]); // back to the shipped default
  }
  assert.strictEqual(S.asksForInput('Сейчас от тебя: путь'), true);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' screen tests passed');
