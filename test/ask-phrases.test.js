// Plain-node tests for the user-editable «agent is calling me» phrases. This list is
// the ONLY signal separating «готов» from «ждёт ответа» at the end of a turn, and it
// feeds two very different consumers (screen scraping + the Stop hook), so its
// normalisation and matching are pinned here.
const assert = require('assert');
const A = require('../ask-phrases');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const asks = (text, list) => A.asksWith(A.buildAskMatcher(list), text);

test('the default phrase calls the user', () => {
  assert.strictEqual(asks('Готово. Сейчас от тебя: путь к схеме', []), true);
});

test('«ничего, жди …» after the phrase is NOT a call', () => {
  assert.strictEqual(asks('Сейчас от тебя: ничего, жди ревью', []), false);
});

test('no phrase at all is not a call', () => {
  assert.strictEqual(asks('Всё сделал, тесты зелёные.', []), false);
});

test('a custom phrase replaces the default', () => {
  assert.strictEqual(asks('Жду твоего слова', ['Жду твоего слова']), true);
  assert.strictEqual(asks('Сейчас от тебя: путь', ['Жду твоего слова']), false);
});

test('several phrases all work, and the «ничего/жди» rule applies to each', () => {
  const list = ['Сейчас от тебя', 'Жду ответа'];
  assert.strictEqual(asks('Жду ответа по деплою', list), true);
  assert.strictEqual(asks('Жду ответа: ничего, жди', list), false);
});

test('matching ignores case', () => {
  assert.strictEqual(asks('СЕЙЧАС ОТ ТЕБЯ: решение', []), true);
});

test('regex metacharacters in a phrase are literal, not a pattern', () => {
  assert.strictEqual(asks('Твой ход (важно)', ['Твой ход (важно)']), true);
  assert.strictEqual(asks('Твой ход важно', ['Твой ход (важно)']), false, 'must not act as a group');
  assert.doesNotThrow(() => A.buildAskMatcher(['[', '(', '\\']));
});

test('normalize: trims, drops empties, collapses inner spaces', () => {
  assert.deepStrictEqual(A.normalizePhrases(['  Жду   ответа  ', '', '   ']), ['Жду ответа']);
});

test('normalize: de-dupes case-insensitively, keeping the first spelling', () => {
  assert.deepStrictEqual(A.normalizePhrases(['Жду ответа', 'жду ответа']), ['Жду ответа']);
});

test('normalize: empty input falls back to the shipped default', () => {
  assert.deepStrictEqual(A.normalizePhrases([]), A.DEFAULT_ASK_PHRASES);
  assert.deepStrictEqual(A.normalizePhrases(null), A.DEFAULT_ASK_PHRASES);
});

test('normalize: caps the count and the length of one phrase', () => {
  const many = Array.from({ length: A.MAX_PHRASES + 5 }, (_, i) => 'фраза ' + i);
  assert.strictEqual(A.normalizePhrases(many).length, A.MAX_PHRASES);
  assert.strictEqual(A.normalizePhrases(['x'.repeat(A.MAX_LEN + 40)])[0].length, A.MAX_LEN);
});

test('phraseSources are JSON-safe strings the hook can recompile', () => {
  const src = A.phraseSources(['Жду ответа']);
  assert.strictEqual(typeof src.mark, 'string');
  const round = { mark: new RegExp(src.mark, 'i'), none: new RegExp(src.none, 'i') };
  assert.strictEqual(A.asksWith(round, 'Жду ответа сейчас'), true);
  assert.strictEqual(A.asksWith(round, 'Жду ответа: ничего, жди'), false);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' ask-phrases tests passed');
