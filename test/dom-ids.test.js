// Контрактный тест разметки: каждый id, который рендерер ИЩЕТ, должен быть в разметке.
// Ловит класс ошибок, который тестами логики не виден и в дев-режиме легко пропустить:
// опечатка в '#set-voice-instal' даёт null, обращение к нему бросает, и панель настроек
// умирает целиком — вместе со всем, что рисуется после. Ровно как preload-contract.test.js
// для window.swarm, только для DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Объявленные id: и в index.html, и в шаблонных строках самого рендерера (модалки и
// панель настроек собираются там).
const declared = new Set();
for (const m of (renderer + html).matchAll(/id=["']([\w-]+)["']/g)) declared.add(m[1]);

// Запрошенные: querySelector('#…') и getElementById('…'). Составные селекторы
// (`.modal #x`) намеренно не разбираем — их в проекте нет, а разбор CSS ради теста
// был бы дороже пользы.
function queried() {
  const out = new Map();
  for (const m of renderer.matchAll(/querySelector\(\s*['"`]#([\w-]+)['"`]\s*\)/g)) {
    out.set(m[1], (renderer.slice(0, m.index).match(/\n/g) || []).length + 1);
  }
  for (const m of renderer.matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]\s*\)/g)) {
    out.set(m[1], (renderer.slice(0, m.index).match(/\n/g) || []).length + 1);
  }
  return out;
}

test('каждый id, который ищет рендерер, объявлен в разметке', () => {
  const missing = [...queried()].filter(([id]) => !declared.has(id))
    .map(([id, line]) => `#${id} (renderer.js:${line})`);
  assert.deepStrictEqual(missing, [], 'запрошены, но не объявлены: ' + missing.join(', '));
});

test('поиск вообще что-то нашёл (страховка от сломанного разбора)', () => {
  assert.ok(declared.size > 50, 'объявленных id подозрительно мало: ' + declared.size);
  assert.ok(queried().size > 30, 'запрошенных id подозрительно мало: ' + queried().size);
});

// Кнопка голоса — новая и целиком построена на этих id; если панель их не найдёт,
// пользователь увидит пустое место вместо установки в один клик.
test('элементы установки голоса на месте', () => {
  for (const id of ['set-voice-model', 'set-voice-install', 'set-voice-cancel',
    'set-voice-remove', 'set-voice-progress', 'set-voice-bar', 'set-voice-note',
    'set-voice-manual', 'set-voice-manual-box']) {
    assert.ok(declared.has(id), 'нет в разметке: #' + id);
  }
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' dom-ids tests passed');
