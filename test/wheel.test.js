// Контракт прокрутки: колесо мыши НИКОГДА не уходит в pty.
//
// Claude включает отчёты о мыши, и по умолчанию xterm отдаёт колесо агенту, а не своему
// скроллбеку: агент листает свой вид, перерисовывает экран старой перепиской — и детектор,
// который читает именно экран, видит вопрос, заданный полчаса назад, без спиннера. Симптом:
// «прокрутил работающую вкладку вверх → стала готова и прислала уведомление о старом
// вопросе». Тест сторожит и саму заглушку, и внутреннее API xterm, на которое опирается
// наша прокрутка: обновление вендора с переименованным handleWheel должно падать здесь,
// а не тишиной в чужой вкладке.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const xterm = fs.readFileSync(path.join(root, 'renderer', 'vendor', 'xterm.js'), 'utf8');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('колесо не превращается в отчёт о мыши: свой обработчик возвращает false', () => {
  assert.ok(/attachCustomWheelEventHandler\(\(\)\s*=>\s*false\)/.test(renderer),
    'нет attachCustomWheelEventHandler(() => false) — xterm снова дошлёт колесо агенту');
});

test('колесо перехвачено на holder и заглушено', () => {
  const m = renderer.match(/holder\.addEventListener\('wheel',[\s\S]{0,400}?\{ capture: true, passive: false \}\)/);
  assert.ok(m, 'нет wheel-слушателя на holder с capture: true, passive: false');
  assert.ok(m[0].includes('ev.preventDefault()'), 'без preventDefault браузер прокрутит вид второй раз');
  assert.ok(m[0].includes('ev.stopPropagation()'), 'без stopPropagation событие дойдёт до xterm');
  assert.ok(m[0].includes('handleWheel(ev)'), 'перехватили колесо, но ничего не прокручиваем');
});

test('xterm всё ещё умеет viewport.handleWheel (на нём держится наша прокрутка)', () => {
  assert.ok(xterm.includes('handleWheel('), 'в бандле xterm нет handleWheel');
  assert.ok(xterm.includes('_getPixelsScrolled('),
    'нет _getPixelsScrolled — попиксельная прокрутка трекпада внутри handleWheel');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} wheel tests passed`);
