// Тесты выбора «бандл или обновлённый код» (boot-core). Без fs и electron.
// Запуск: node test/boot.test.js
const assert = require('assert');
const core = require('../boot-core');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const BUNDLE = '0.30.0';
const state = (over) => Object.assign({ pointer: null, marker: null, bundleVersion: BUNDLE }, over || {});
const pointer = (over) => Object.assign({ version: '0.31.0', file: '0.31.0.asar' }, over || {});

test('без указателя запускается код из бандла', () => {
  const d = core.decideBoot(state());
  assert.strictEqual(d.kind, 'bundle');
});

test('свежее обновление запускается вместо бандла', () => {
  const d = core.decideBoot(state({ pointer: pointer() }));
  assert.deepStrictEqual(
    { kind: d.kind, file: d.file, version: d.version },
    { kind: 'payload', file: '0.31.0.asar', version: '0.31.0' }
  );
});

test('обновление не новее бандла игнорируется — приложение переставили', () => {
  // Человек скачал dmg 0.30.0 поверх, а рядом лежит обновление 0.30.0 от прошлого раза.
  assert.strictEqual(core.decideBoot(state({ pointer: pointer({ version: '0.30.0' }) })).kind, 'bundle');
  assert.strictEqual(core.decideBoot(state({ pointer: pointer({ version: '0.29.1' }) })).kind, 'bundle');
});

test('битый указатель не роняет запуск', () => {
  for (const p of [{}, { version: '0.31.0' }, { file: 'x.asar' }, { version: 1, file: 'x.asar' }]) {
    assert.strictEqual(core.decideBoot(state({ pointer: p })).kind, 'bundle');
  }
});

test('указатель не уводит загрузку из своей папки', () => {
  for (const file of ['../../evil.asar', '/etc/passwd', '..', 'sub\\evil.asar', '']) {
    assert.strictEqual(core.decideBoot(state({ pointer: pointer({ file }) })).kind, 'bundle');
  }
});

test('версия, уже уронившая запуск, второй раз не пробуется', () => {
  const d = core.decideBoot(state({ pointer: pointer(), marker: { version: '0.31.0' } }));
  assert.strictEqual(d.kind, 'bundle');
  assert.strictEqual(d.bad, '0.31.0.asar');   // файл убирается с дороги
  assert.match(d.reason, /не дошёл/);
});

test('метка от другой версии не мешает новому обновлению', () => {
  // Прошлое обновление падало, следующее приехало с исправлением — оно должно поехать.
  const d = core.decideBoot(state({ pointer: pointer({ version: '0.32.0', file: '0.32.0.asar' }), marker: { version: '0.31.0' } }));
  assert.strictEqual(d.kind, 'payload');
  assert.strictEqual(d.bad, undefined);
});

test('safeName пропускает только простые имена', () => {
  assert.strictEqual(core.safeName('0.31.0.asar'), true);
  assert.strictEqual(core.safeName('a/b'), false);
  assert.strictEqual(core.safeName('..'), false);
  assert.strictEqual(core.safeName(null), false);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
