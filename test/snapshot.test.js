// Regression test for the snapshot WINDOW, run against the real terminal emulator
// the app uses (@xterm/headless) — the escape-sequence behaviour is the whole point,
// so a hand-built fake buffer wouldn't prove anything here.
//
// The bug: Claude Code's UI is a frame that grows and shrinks. Shrinking is drawn as
// "cursor up N + erase to end of screen"; the rows the tall frame had scrolled into
// the buffer stay allocated but blank, and buf.length never shrinks. A window
// anchored to buf.length then reads those blank rows instead of the screen, so a tab
// showing «Сейчас от тебя: …» painted «готов» (green) with a question sitting on it.
const assert = require('assert');
const { Terminal } = require('@xterm/headless');
const S = require('../screen');
const D = require('../detector');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const COLS = 118, ROWS = 64, SNAP_ROWS = 16;
const ASK = '  Сейчас от тебя: партнёрка или курьерка? (если партнёрка — скажи, есть ли у тебя доступ)';

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

// A finished turn as it really looks: the answer, the "Baked for" line, the input
// box, the hint row and the user's statusline pinned at the bottom.
async function finishedTurn() {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true });
  await write(term, 'что-то из транскрипта\r\n'.repeat(120));
  await write(term, ASK + '\r\n\r\n✻ Baked for 45s\r\n\r\n');
  await write(term, '╭' + '─'.repeat(COLS - 2) + '╮\r\n│ >' + ' '.repeat(COLS - 4) + '│\r\n╰' + '─'.repeat(COLS - 2) + '╯\r\n');
  await write(term, '  ? for shortcuts\r\n');
  await write(term, 'Opus 4.8 │ fastio ███░░░ 32% 1M │ 🔧 #221 задача');
  return term;
}

// Claude Code paints a taller frame (permission box, a multi-line input, the
// sub-agent roster), then redraws a shorter one over it.
async function shrinkFrame(term, rows) {
  await write(term, '\r\n' + 'высокий кадр\r\n'.repeat(rows));
  await write(term, `\x1b[${rows}A\x1b[J`);   // cursor up N, erase to end of screen
}

test('a finished turn is read as «ждёт»', async () => {
  const term = await finishedTurn();
  const snap = S.snapshotRows(term.buffer.active, SNAP_ROWS);
  assert.ok(snap.includes('Сейчас от тебя'), 'marker must be in the snapshot');
  const d = { term, lastDataAt: Date.now() - 5000 };
  assert.strictEqual(D.decide(d, Date.now(), snap).status, 'waiting');
});

test('a shrunken frame leaves blank rows the window must skip', async () => {
  const term = await finishedTurn();
  await shrinkFrame(term, 11);
  const buf = term.buffer.active;
  // The blank tail is real: this is what used to swallow the whole window.
  assert.ok(S.contentEnd(buf) < buf.length, 'expected blank rows below the content');
  const snap = S.snapshotRows(buf, SNAP_ROWS);
  assert.ok(snap.includes('Сейчас от тебя'), 'question must survive the shrunken frame');
  assert.ok(snap.includes('│ fastio'), 'statusline must stay inside the window too');
  const d = { term, lastDataAt: Date.now() - 5000 };
  assert.strictEqual(D.decide(d, Date.now(), snap).status, 'waiting');
});

test('a permission prompt survives a shrunken frame as well', async () => {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true });
  await write(term, 'работа\r\n'.repeat(120));
  await write(term, '│ Do you want to proceed?\r\n│ ❯ 1. Yes\r\n│   2. No, and tell Claude what to do\r\n  Esc to cancel\r\n');
  await shrinkFrame(term, 20);
  const snap = S.snapshotRows(term.buffer.active, SNAP_ROWS);
  const d = { term, lastDataAt: Date.now() };
  const raw = D.decide(d, Date.now(), snap);
  assert.strictEqual(raw.status, 'waiting');
  assert.strictEqual(raw.kind, 'permission');
});

// --- перенос по ширине окна — не перевод строки -------------------------------
// В телегу уезжала лестница: терминал ломает абзац по ширине, каждый обрывок ложится
// отдельным рядом, и в чате это выглядело как переводы строки посреди слов. Ширина окна —
// свойство того, кто смотрит; в ответе её быть не должно. Проверяем на живом эмуляторе:
// признак ряда-продолжения (isWrapped) ставит он сам, подделкой это не доказать.
const LONG = 'Готово: подчистил маршрутизацию, переписал разбор ответа и прогнал сюиту — '
  + 'зелёная, тридцать восемь тестов, ни одного пропущенного, дальше можно выпускать.';

test('snapshotWrapped склеивает перенесённые ряды обратно в абзац', async () => {
  const term = new Terminal({ cols: 60, rows: 20, scrollback: 200, allowProposedApi: true });
  await write(term, 'что-то выше\r\n');
  await write(term, LONG + '\r\n');
  const buf = term.buffer.active;
  const rows = S.snapshotRows(buf, SNAP_ROWS);
  assert.ok(rows.split('\n').length > 3, 'терминал действительно разложил абзац по рядам');
  const glued = S.snapshotWrapped(buf, SNAP_ROWS);
  assert.ok(glued.includes(LONG), 'абзац должен вернуться одной строкой:\n' + glued);
});

test('snapshotWrapped не срастает слова на стыке рядов', async () => {
  // Перенос попадает ровно на пробел: обрезав ряду хвост, мы бы склеили «сюиту» и «зелёная».
  const term = new Terminal({ cols: 24, rows: 12, scrollback: 200, allowProposedApi: true });
  await write(term, 'раз два три четыре пять шесть семь восемь\r\n');
  const glued = S.snapshotWrapped(term.buffer.active, SNAP_ROWS);
  assert.ok(glued.includes('раз два три четыре пять шесть семь восемь'), glued);
});

test('snapshotWrapped оставляет настоящие переводы строки на месте', async () => {
  const term = new Terminal({ cols: 60, rows: 20, scrollback: 200, allowProposedApi: true });
  await write(term, 'первая строка\r\nвторая строка\r\n');
  assert.strictEqual(S.snapshotWrapped(term.buffer.active, SNAP_ROWS), 'первая строка\nвторая строка');
});

// Весь путь отчёта в телегу для вкладки БЕЗ стенограммы: живой экран → склейка переносов →
// сообщение агента целиком. Проверяется целиком, потому что ломалось именно на стыках.
test('ответ с экрана уходит абзацами и без мебели', async () => {
  const term = new Terminal({ cols: 60, rows: 24, scrollback: 200, allowProposedApi: true });
  await write(term, '⏺ Bash(npm test)\r\n  ⎿ 38 tests passed\r\n\r\n');
  await write(term, '⏺ ' + LONG + '\r\n\r\n  Осталось выпустить.\r\n\r\n');
  await write(term, '  Jump to bottom (click) ↓\r\n');
  await write(term, '╭' + '─'.repeat(58) + '╮\r\n│ >' + ' '.repeat(56) + '│\r\n╰' + '─'.repeat(58) + '╯\r\n');
  await write(term, '  ⏵⏵ auto mode on · ? for shortcuts\r\n');
  const said = S.lastAgentBlock(S.snapshotWrapped(term.buffer.active, 200));
  assert.strictEqual(said, LONG + '\n\nОсталось выпустить.');
});

test('an all-blank screen yields an empty snapshot, not a crash', async () => {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true });
  assert.strictEqual(S.snapshotRows(term.buffer.active, SNAP_ROWS), '');
  assert.strictEqual(S.contentEnd(term.buffer.active), 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' snapshot tests passed');
})();
