// Plain-node tests for reading status off Claude's own .jsonl transcript. Fixtures
// mirror the real shapes seen in ~/.claude/projects/<slug>/<session>.jsonl: message
// lines (assistant/user) interleaved with bookkeeping lines (mode, ai-title, …) and
// with sub-agent lines (isSidechain).
const assert = require('assert');
const T = require('../transcript');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

const line = (o) => JSON.stringify(o);
const assistant = (content, msAgo = 0, extra = {}) => line(Object.assign({
  type: 'assistant', timestamp: at(msAgo), cwd: '/repo', message: { role: 'assistant', content },
}, extra));
const user = (content, msAgo = 0, extra = {}) => line(Object.assign({
  type: 'user', timestamp: at(msAgo), cwd: '/repo', message: { role: 'user', content },
}, extra));
const NOISE = [
  line({ type: 'mode', mode: 'default', sessionId: 's' }),
  line({ type: 'ai-title', aiTitle: 'что-то', sessionId: 's' }),
  line({ type: 'file-history-snapshot', messageId: 'm' }),
].join('\n');

const asks = (t) => /Сейчас от тебя/.test(t);
const verdict = (text, now = NOW) => T.classify(T.parseEntries(text), now, asks);

test('a running tool → работает', () => {
  const v = verdict([NOISE, assistant([{ type: 'tool_use', name: 'Bash', input: {} }], 200)].join('\n'));
  assert.strictEqual(v.status, 'running');
  assert.strictEqual(v.why, 'tool_use');
});

test('a tool result → работает (the model is thinking)', () => {
  const v = verdict(user([{ type: 'tool_result', content: 'ok' }], 3000));
  assert.strictEqual(v.status, 'running');
});

test('your own prompt → работает', () => {
  const v = verdict(user('почини тесты', 5000));
  assert.strictEqual(v.status, 'running');
});

test('a fresh assistant text is still работает (the turn may continue)', () => {
  const v = verdict(assistant([{ type: 'text', text: 'Сделал первую часть.' }], 300));
  assert.strictEqual(v.status, 'running');
  assert.strictEqual(v.why, 'text (fresh)');
});

test('a quiet assistant text → готов', () => {
  const v = verdict(assistant([{ type: 'text', text: 'Готово, тесты зелёные.' }], T.READY_DEBOUNCE_MS + 500));
  assert.strictEqual(v.status, 'ready');
});

test('a quiet assistant text WITH a call phrase → ждёт: вопрос', () => {
  const v = verdict(assistant([{ type: 'text', text: 'Сейчас от тебя: путь к схеме' }], 5000));
  assert.strictEqual(v.status, 'waiting');
  assert.strictEqual(v.kind, 'question');
});

test('thinking-only entries never read as a finished turn text', () => {
  const v = verdict(assistant([{ type: 'thinking', thinking: 'Сейчас от тебя: путь' }], 5000));
  assert.strictEqual(v.status, 'ready', 'thinking is invisible to the user, so it cannot call them');
  assert.strictEqual(T.entryText(JSON.parse(assistant([{ type: 'thinking', thinking: 'x' }]))), '');
});

test('sub-agent lines never drive the tab: the main thread decides', () => {
  const text = [
    assistant([{ type: 'tool_use', name: 'Task', input: {} }], 9000),
    assistant([{ type: 'text', text: 'подагент закончил' }], 100, { isSidechain: true }),
  ].join('\n');
  const v = verdict(text);
  assert.strictEqual(v.status, 'running');
  assert.strictEqual(v.why, 'tool_use', 'the sidechain text must not end the turn');
});

test('bookkeeping lines are skipped entirely', () => {
  assert.deepStrictEqual(T.parseEntries(NOISE), []);
  assert.strictEqual(T.classify(T.parseEntries(NOISE), NOW, asks), null);
});

test('a truncated first line (tail read) is skipped, not fatal', () => {
  const chopped = '{"type":"assist' + '\n' + assistant([{ type: 'text', text: 'ок' }], 5000);
  const v = verdict(chopped);
  assert.strictEqual(v.status, 'ready');
});

test('string content counts as text', () => {
  const v = verdict(assistant('Сейчас от тебя: ответь', 5000));
  assert.strictEqual(v.status, 'waiting');
});

test('cwdOf reads the folder the session belongs to', () => {
  assert.strictEqual(T.cwdOf(T.parseEntries(assistant([{ type: 'text', text: 'x' }]))), '/repo');
  assert.strictEqual(T.cwdOf([]), null);
});

test('projectSlug flattens the path the way Claude names its folders', () => {
  assert.strictEqual(T.projectSlug('/Users/e/WebstormProjects/claude-swarm-lite'),
    '-Users-e-WebstormProjects-claude-swarm-lite');
  assert.strictEqual(T.projectSlug('/Users/e/.config/app'), '-Users-e--config-app');
});

// Windows: the drive colon counts too. Without it the slug is `C:-Users-me-p` while Claude
// writes `C--Users-me-p`, so the transcript channel looks in a folder that never exists.
test('projectSlug flattens a Windows path with a drive letter', () => {
  assert.strictEqual(T.projectSlug('C:\\Users\\me\\WebstormProjects\\swarm'),
    'C--Users-me-WebstormProjects-swarm');
  assert.strictEqual(T.projectSlug('D:\\work\\my.app'), 'D--work-my-app');
});

// --- pickBinding: which file belongs to this tab ------------------------------

const OPEN = 100_000;   // when the tab opened
const cand = (over) => Object.assign({ file: 'a.jsonl', mtimeMs: OPEN + 500, cwdInside: '/repo' }, over);
const pick = (cands, over) => T.pickBinding(cands, Object.assign({ startedAt: OPEN, cwd: '/repo' }, over));

test('pickBinding takes the one fresh file recording this cwd', () => {
  assert.strictEqual(pick([cand({ file: 'mine.jsonl' })]), 'mine.jsonl');
});

test('pickBinding ignores a file untouched since the tab opened', () => {
  assert.strictEqual(pick([cand({ mtimeMs: OPEN - 60_000 })]), null);
});

test('pickBinding tolerates a little clock jitter around the tab start', () => {
  assert.strictEqual(pick([cand({ mtimeMs: OPEN - 1000 })]), 'a.jsonl');
});

test('pickBinding ignores a file whose recorded cwd is another folder', () => {
  assert.strictEqual(pick([cand({ cwdInside: '/other' })]), null);
  assert.strictEqual(pick([cand({ cwdInside: null })]), null, 'unreadable is not a match');
});

test('pickBinding skips a file already bound to another tab', () => {
  assert.strictEqual(pick([cand({ file: 'taken.jsonl' })], { taken: new Set(['taken.jsonl']) }), null);
});

test('pickBinding binds NOTHING when two files qualify (never guess between tabs)', () => {
  assert.strictEqual(pick([cand({ file: 'a.jsonl' }), cand({ file: 'b.jsonl' })]), null);
});

test('pickBinding survives junk input', () => {
  assert.strictEqual(pick([]), null);
  assert.strictEqual(pick(null), null);
  assert.strictEqual(pick([null, cand()]), 'a.jsonl');
  assert.strictEqual(T.pickBinding([cand()], null), null, 'no cwd to match against');
});

// --- pickByScreen: telling two tabs in one folder apart -----------------------

const sc = (over) => Object.assign({ file: 'a.jsonl', text: '' }, over);
const LONG = 'Починил сборку, тесты зелёные, дифф оставил незакоммиченным для ревью';

test('pickByScreen finds the transcript whose last message is on this screen', () => {
  const cands = [sc({ file: 'mine.jsonl', text: LONG }), sc({ file: 'other.jsonl', text: 'Совсем другой текст про совсем другую задачу целиком' })];
  // The terminal wraps the same sentence differently — the match must survive that.
  const snap = 'Починил сборку, тесты зелёные, дифф оставил\nнезакоммиченным для ревью\n> ';
  assert.strictEqual(T.pickByScreen(cands, snap), 'mine.jsonl');
});

test('pickByScreen refuses when two candidates match', () => {
  const cands = [sc({ file: 'a.jsonl', text: LONG }), sc({ file: 'b.jsonl', text: LONG })];
  assert.strictEqual(T.pickByScreen(cands, LONG), null);
});

test('pickByScreen refuses when nothing matches, or there is too little to go on', () => {
  assert.strictEqual(T.pickByScreen([sc({ text: LONG })], 'пустой экран > '), null);
  assert.strictEqual(T.pickByScreen([sc({ text: 'коротко' })], LONG), null, 'short text proves nothing');
  assert.strictEqual(T.pickByScreen([], LONG), null);
});

test('screenKey ignores whitespace, case and punctuation', () => {
  assert.strictEqual(T.screenKey('Готово!  Тесты — зелёные.'), T.screenKey('готово тесты\nзелёные'));
});

// --- привязка по тексту, который напечатал мост -------------------------------
// Живой случай: три вкладки на одной папке, все разговоры свежие, ни один не выигрывает
// по однозначности — вкладка осталась без стенограммы, и в телегу уехало «✅ готов» без
// текста ответа. Но мост ЗНАЕТ, что напечатал, и метка [тлг] есть только в его репликах.

const injected = '[тлг: отвечай коротко] Посмотри, почему падает тест на миграциях';

test('pickByInjected находит файл по дословному тексту из телеги', () => {
  const cands = [
    { file: 'other.jsonl', userText: 'привет\nсделай рефакторинг' },
    { file: 'mine.jsonl', userText: 'старое сообщение\n' + injected },
  ];
  assert.strictEqual(T.pickByInjected(cands, injected), 'mine.jsonl');
});

test('pickByInjected молчит, когда текста нет ни в одном файле', () => {
  const cands = [{ file: 'a.jsonl', userText: 'привет' }, { file: 'b.jsonl', userText: 'ага' }];
  assert.strictEqual(T.pickByInjected(cands, injected), null);
});

// Короткий ключ ничего не доказывает: «да» встречается в любом разговоре, и привязка по
// нему увела бы статус одного агента на вкладку другого.
test('pickByInjected не верит короткому совпадению', () => {
  const cands = [{ file: 'a.jsonl', userText: 'да, вариант 2' }];
  assert.strictEqual(T.pickByInjected(cands, 'да'), null);
  assert.strictEqual(T.pickByInjected(cands, ''), null);
  assert.strictEqual(T.pickByInjected(cands, null), null);
});

test('pickByInjected отказывается при двух совпадениях, как остальные ключи', () => {
  const cands = [
    { file: 'a.jsonl', userText: injected },
    { file: 'b.jsonl', userText: injected },
  ];
  assert.strictEqual(T.pickByInjected(cands, injected), null);
});

// --- текст этого хода или прошлого -------------------------------------------
// Живая беда: статус «готов» приходит от хука Stop сразу, а classify до конца своего отстоя
// (READY_DEBOUNCE_MS) держит «работает» и текст НЕ обновляет. Значит в момент, когда мост
// решает докладывать, свежего текста ещё нет — а прошлый есть и выглядит нормально. В чат
// уезжал ответ не на ту задачу.

test('belongsToTurn: текст, записанный после начала хода, принадлежит ходу', () => {
  const turnStarted = 1000;
  assert.strictEqual(T.belongsToTurn(1200, turnStarted), true);
  assert.strictEqual(T.belongsToTurn(1000, turnStarted), true, 'ровно в начало — уже этот ход');
});

test('belongsToTurn: текст прошлого хода не сойдёт за итог нового', () => {
  assert.strictEqual(T.belongsToTurn(900, 1000), false);
});

test('belongsToTurn: пустые значения не притворяются свежим текстом', () => {
  assert.strictEqual(T.belongsToTurn(0, 1000), false, 'текста ещё не было');
  assert.strictEqual(T.belongsToTurn(null, 1000), false);
  assert.strictEqual(T.belongsToTurn(undefined, 1000), false);
});

// Ход ещё не начинался (вкладка только что открыта, приложение только что запущено): тогда
// сравнивать не с чем, и текст стенограммы — единственное, что есть. Отказываться от него
// незачем: он про то, что в этой вкладке и происходило.
test('belongsToTurn: без известного начала хода текст годится', () => {
  assert.strictEqual(T.belongsToTurn(1200, 0), true);
  assert.strictEqual(T.belongsToTurn(1200, null), true);
});

// Отстой classify — это НЕ таймер моста, а причина, по которой мост обязан подождать. Пусть
// связь между ними будет видна: если отстой станет нулём, ждать было бы нечего.
test('READY_DEBOUNCE_MS — не ноль, иначе и ждать текст незачем', () => {
  assert.ok(T.READY_DEBOUNCE_MS > 0);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' transcript tests passed');
