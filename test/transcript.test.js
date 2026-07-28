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

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' transcript tests passed');
