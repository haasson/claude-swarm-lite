// Plain-node tests for the hook-marker parser (osc.js).
const assert = require('assert');
const { extractHookSignals } = require('../osc');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const BEL = '\x07';
// Маркер как его печатает хук: токен, id сессии и АДРЕС стенограммы (см. osc.js).
const mk = (token, sid, tr) => '\x1b]777;notify;swarm;' + token
  + (sid != null ? ';' + sid : '') + (tr != null ? ';' + tr : '') + BEL;

test('parses a single marker with a session id', () => {
  const { signals } = extractHookSignals('output' + mk('perm', 'abc123') + 'more');
  assert.deepStrictEqual(signals, [{ token: 'perm', sessionId: 'abc123', transcript: null }]);
});

test('parses a marker without a session id', () => {
  const { signals } = extractHookSignals(mk('idle'));
  assert.deepStrictEqual(signals, [{ token: 'idle', sessionId: null, transcript: null }]);
});

test('accepts an ST terminator (ESC \\) as well as BEL', () => {
  const { signals } = extractHookSignals('\x1b]777;notify;swarm;busy;s1\x1b\\');
  assert.deepStrictEqual(signals, [{ token: 'busy', sessionId: 's1', transcript: null }]);
});

test('parses several markers in one chunk', () => {
  const { signals } = extractHookSignals(mk('busy') + 'x' + mk('ask', 'q9'));
  assert.deepStrictEqual(signals, [
    { token: 'busy', sessionId: null, transcript: null },
    { token: 'ask', sessionId: 'q9', transcript: null },
  ]);
});

// Адрес стенограммы — то, ради чего у маркера третье поле. Без него приложение складывало
// путь само (~/.claude/projects/…) и у вкладки с другим CLAUDE_CONFIG_DIR не находило файл
// никогда: в телегу уезжал текст, соскобленный с картинки терминала.
test('маркер несёт адрес стенограммы', () => {
  const file = '/Users/x/.claude-my/projects/-Users-x-proj/1f2e3d4c-0000-0000-0000-000000000000.jsonl';
  const { signals } = extractHookSignals('шум' + mk('busy', 'sess-1', file) + 'ещё');
  assert.deepStrictEqual(signals, [{ token: 'busy', sessionId: 'sess-1', transcript: file }]);
});

// Точка с запятой в пути (бывает) не должна ломать разбор: путь идёт последним полем, и
// режется только ПЕРВАЯ точка с запятой.
test('точка с запятой внутри пути сохраняется', () => {
  const file = '/Users/x/.claude/projects/-Users-x-a;b/deadbeef.jsonl';
  const { signals } = extractHookSignals(mk('idle', 'sess-2', file));
  assert.strictEqual(signals[0].transcript, file);
});

// Маркер стал длиной пути, а читается pty кусками — значит хвост, который переносим в
// следующий кусок, обязан вмещать маркер целиком. Иначе статус просто теряется.
test('маркер с длинным путём собирается из двух кусков', () => {
  const file = '/Users/evgeniy/.claude-my/projects/'
    + '-Users-evgeniy-WebstormProjects-fastio--claude-worktrees-prep-ingredients-43/'
    + '47b048de-41f7-44b3-87fa-286b88ba9add.jsonl';
  const full = 'до' + mk('perm', '47b048de-41f7-44b3-87fa-286b88ba9add', file) + 'после';
  const cut = full.length - 12;
  const a = extractHookSignals(full.slice(0, cut));
  assert.strictEqual(a.signals.length, 0, 'ещё не целый');
  const b = extractHookSignals(a.rest + full.slice(cut));
  assert.strictEqual(b.signals.length, 1, 'хвоста не хватило на маркер с путём');
  assert.strictEqual(b.signals[0].transcript, file);
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
  assert.deepStrictEqual(b.signals, [{ token: 'perm', sessionId: 'sess-42', transcript: null }]);
});

test('does not re-emit an already-parsed marker on the next chunk', () => {
  const a = extractHookSignals(mk('idle') + 'tail');
  assert.strictEqual(a.signals.length, 1);
  const b = extractHookSignals(a.rest + ' and more plain output');
  assert.strictEqual(b.signals.length, 0);
});

test('caps the carried tail so non-marker output cannot grow unbounded', () => {
  const { rest } = extractHookSignals('z'.repeat(5000));
  assert.ok(rest.length <= 640, 'carry is capped');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' osc tests passed');
