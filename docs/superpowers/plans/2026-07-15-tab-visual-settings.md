# Настройки визуала вкладок — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать пользователю настраивать плотность вкладок, видимость их элементов, размеры шрифта и цвета статусов; попутно убрать растяжение свёрнутой группы и ужать кнопку «новая сессия» в верхней раскладке.

**Architecture:** Данные и валидация живут в новом UMD-модуле `renderer/tabstyle.js` (как `themes.js`), `renderer.js` только грузит, применяет и рисует панель настроек. Применение — CSS-переменные на `<html>` плюс классы на `<body>`; вкладки не перерисовываются, эффект каскадный.

**Tech Stack:** Electron, ванильный JS без сборки, UMD-модули через `<script>`, тесты — голый `node` + `assert`.

**Спек:** `docs/superpowers/specs/2026-07-15-tab-visual-settings-design.md`

---

## Как проверять работу

**Не запускай приложение** (`npm start`) и не убивай его процессы: в соседних вкладках у пользователя работают живые агенты, перезапуск их снесёт. Проверка — `npm test` и перечитывание изменённых файлов. Визуальную проверку сделает пользователь сам при следующем запуске; в задачах ниже для CSS-шагов указано, что именно должно совпасть при чтении.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `renderer/tabstyle.js` | **новый.** Данные (плотности, цвета, дефолты) + чистые функции `normalizeTabStyle` / `toCssVars` / `bodyClasses`. Ни DOM, ни xterm. |
| `test/tabstyle.test.js` | **новый.** Юнит-тесты модуля под голым node. |
| `renderer/index.html` | `<script>` на модуль до `renderer.js`. |
| `renderer/renderer.js` | `loadTabStyle` / `saveTabStyle` / `applyTabStyle`, панель «Вкладки» в модалке, проводка, save. |
| `renderer/styles.css` | Переменные вместо хардкода, пресеты плотности, классы видимости, стили панели и превью, два фикса раскладки. |
| `package.json` | Строка в цепочке `npm test`. |

Задачи 1 и 2 — независимые фиксы раскладки, они не связаны с остальным и коммитятся отдельно. Задачи 3-8 строят фичу снизу вверх: модуль → проводка → CSS → UI.

---

### Task 1: Свёрнутая группа перестаёт растягиваться

Причина бага: `.layout-top #tabs { align-items: stretch }` (`styles.css:104`) тянет свёрнутую группу по высоте самой высокой соседней, хотя внутри у неё осталась одна шапка.

**Files:**
- Modify: `renderer/styles.css:164` (рядом с остальными правилами `.tab-group.collapsed`)

- [ ] **Step 1: Добавь правило**

Найди в `renderer/styles.css` строку:

```css
.tab-group.collapsed .group-tabs { display: none; }
```

Добавь сразу после неё:

```css
/* Свёрнутая группа ужимается до своей шапки. Развёрнутые продолжают
   выравниваться по высоте друг с другом — за это отвечает align-items:stretch
   на .layout-top #tabs, и трогать его нельзя: тот же stretch выравнивает
   карточки разной высоты внутри .group-tabs. */
.layout-top .tab-group.collapsed { align-self: flex-start; }
```

- [ ] **Step 2: Проверь, что не сломал стиль**

Run: `npm test`
Expected: все тесты проходят (CSS они не покрывают — это проверка, что ты ничего не задел в JS).

Перечитай `renderer/styles.css:98-106` и убедись, что `align-items: stretch` у `.layout-top #tabs` остался на месте.

- [ ] **Step 3: Commit**

```bash
git add renderer/styles.css
git commit -m "fix(tabs): свёрнутая группа не растягивается по высоте соседей"
```

---

### Task 2: Кнопка «новая сессия» в верхней раскладке — только иконка

**Files:**
- Modify: `renderer/styles.css:252-274` (блок `#chrome-actions` / `#new-session-folder`)

- [ ] **Step 1: Добавь правила**

Найди в `renderer/styles.css`:

```css
.layout-top #new-session-folder { padding: 8px 12px; }
```

Замени на:

```css
/* В top-раскладке кнопка съедала ~140px горизонтали ради текста, который
   дублируется тултипом. Оставляем иконку: ⌘O работает, у каждой группы есть
   свой «+» (.group-add). В rail текст остаётся — там она под списком, место есть. */
.layout-top #new-session-folder { padding: 8px; }
.layout-top #new-session-folder .tx { display: none; }
```

Затем найди:

```css
.layout-top  #chrome-actions { align-items: center; padding: 0 10px 0 4px; }
```

Замени на:

```css
.layout-top  #chrome-actions { align-items: center; padding: 0 8px 0 4px; }
```

- [ ] **Step 2: Проверь тултип на месте**

Run: `grep -n 'new-session-folder' renderer/index.html`
Expected: строка содержит `title="Новая сессия в папке… (⌘O)"` — без неё иконка станет загадкой.

Run: `npm test`
Expected: все тесты проходят.

- [ ] **Step 3: Commit**

```bash
git add renderer/styles.css
git commit -m "fix(tabs): кнопка новой сессии в top-раскладке ужата до иконки"
```

---

### Task 3: Модуль `tabstyle.js` — тест

Пишем тест первым, модуля ещё нет. Стиль — копия `test/themes.test.js`: голый node, свой мини-раннер, `require` работает благодаря UMD-обёртке.

**Files:**
- Create: `test/tabstyle.test.js`

- [ ] **Step 1: Напиши падающий тест**

Создай `test/tabstyle.test.js`:

```js
// Plain-node tests for the tab card style settings (no framework: run
// `node test/tabstyle.test.js`). tabstyle.js is dual-mode (browser global +
// CommonJS), so it can be required straight into Node.
const assert = require('assert');
const T = require('../renderer/tabstyle');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const HEX = /^#[0-9a-fA-F]{6}$/;

test('exposes three densities with unique ids and names', () => {
  assert.strictEqual(T.DENSITIES.length, 3);
  const ids = T.DENSITIES.map((d) => d.id);
  assert.deepStrictEqual(ids, ['compact', 'normal', 'roomy']);
  for (const d of T.DENSITIES) assert.ok(d.name && typeof d.name === 'string', d.id);
});

test('COLORS describes exactly the keys of DEFAULT_TABSTYLE.colors', () => {
  const listed = T.COLORS.map((c) => c.key).sort();
  const actual = Object.keys(T.DEFAULT_TABSTYLE.colors).sort();
  assert.deepStrictEqual(listed, actual);
  for (const c of T.COLORS) assert.ok(c.name && typeof c.name === 'string', c.key);
});

test('default colors mirror the hardcoded :root palette (regression)', () => {
  // styles.css:10-22 — если правишь палитру там, правь и здесь.
  assert.deepStrictEqual(T.DEFAULT_TABSTYLE.colors, {
    accent:  '#3fd0c9',
    run:     '#e0a53f',
    ready:   '#4ade80',
    waiting: '#3fd0c9',
    danger:  '#e05a5a',
  });
});

test('every default color is a valid hex', () => {
  for (const k of Object.keys(T.DEFAULT_TABSTYLE.colors)) {
    assert.ok(HEX.test(T.DEFAULT_TABSTYLE.colors[k]), k);
  }
});

test('normalizeTabStyle fills defaults from empty/garbage input', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const s = T.normalizeTabStyle(bad);
    assert.strictEqual(s.density, 'normal', String(bad));
    assert.strictEqual(s.labelSize, 12);
    assert.strictEqual(s.subSize, 10);
    assert.deepStrictEqual(s.show, { dot: true, ctx: true, sub: true, statusFill: true });
    assert.deepStrictEqual(s.colors, T.DEFAULT_TABSTYLE.colors);
  }
});

test('normalizeTabStyle falls back on unknown density', () => {
  assert.strictEqual(T.normalizeTabStyle({ density: 'bogus' }).density, 'normal');
  assert.strictEqual(T.normalizeTabStyle({ density: 'compact' }).density, 'compact');
});

test('normalizeTabStyle clamps labelSize to 9..18 and subSize to 8..14', () => {
  assert.strictEqual(T.normalizeTabStyle({ labelSize: 2 }).labelSize, 9);
  assert.strictEqual(T.normalizeTabStyle({ labelSize: 99 }).labelSize, 18);
  assert.strictEqual(T.normalizeTabStyle({ labelSize: '15' }).labelSize, 15);
  assert.strictEqual(T.normalizeTabStyle({ labelSize: 'abc' }).labelSize, 12);
  assert.strictEqual(T.normalizeTabStyle({ subSize: 1 }).subSize, 8);
  assert.strictEqual(T.normalizeTabStyle({ subSize: 99 }).subSize, 14);
  assert.strictEqual(T.normalizeTabStyle({ subSize: '11' }).subSize, 11);
});

test('normalizeTabStyle keeps valid booleans and fills missing ones', () => {
  const s = T.normalizeTabStyle({ show: { dot: false, sub: 'yes' } });
  assert.strictEqual(s.show.dot, false);
  assert.strictEqual(s.show.sub, true, 'non-boolean falls back to default');
  assert.strictEqual(s.show.ctx, true);
  assert.strictEqual(s.show.statusFill, true);
});

test('normalizeTabStyle rejects a bad hex and lowercases a good one', () => {
  const s = T.normalizeTabStyle({ colors: { accent: 'red', run: '#ABCDEF' } });
  assert.strictEqual(s.accent, undefined, 'colors live under .colors');
  assert.strictEqual(s.colors.accent, T.DEFAULT_TABSTYLE.colors.accent);
  assert.strictEqual(s.colors.run, '#abcdef');
});

test('normalizeTabStyle deep-copies: mutating the result leaves input alone', () => {
  const input = T.normalizeTabStyle(null);
  const copy = T.normalizeTabStyle(input);
  copy.show.dot = false;
  copy.colors.accent = '#000000';
  assert.strictEqual(input.show.dot, true);
  assert.strictEqual(input.colors.accent, T.DEFAULT_TABSTYLE.colors.accent);
});

test('toCssVars returns exactly the seven vars, with units on sizes', () => {
  const v = T.toCssVars(T.normalizeTabStyle(null));
  assert.deepStrictEqual(Object.keys(v).sort(), [
    '--accent', '--danger', '--ready', '--run', '--tab-label-size', '--tab-sub-size', '--waiting',
  ]);
  assert.strictEqual(v['--tab-label-size'], '12px');
  assert.strictEqual(v['--tab-sub-size'], '10px');
  assert.strictEqual(v['--accent'], '#3fd0c9');
});

test('toCssVars normalizes garbage instead of emitting it', () => {
  const v = T.toCssVars({ labelSize: 999, colors: { danger: 'oops' } });
  assert.strictEqual(v['--tab-label-size'], '18px');
  assert.strictEqual(v['--danger'], T.DEFAULT_TABSTYLE.colors.danger);
});

test('bodyClasses always names the density and nothing else by default', () => {
  assert.deepStrictEqual(T.bodyClasses(T.normalizeTabStyle(null)), ['tabs-normal']);
  assert.deepStrictEqual(T.bodyClasses({ density: 'compact' }), ['tabs-compact']);
});

test('bodyClasses adds one tab-no-* class per hidden element', () => {
  const all = T.bodyClasses({ show: { dot: false, ctx: false, sub: false, statusFill: false } });
  assert.deepStrictEqual(all, ['tabs-normal', 'tab-no-dot', 'tab-no-ctx', 'tab-no-sub', 'tab-no-fill']);
  assert.deepStrictEqual(T.bodyClasses({ show: { sub: false } }), ['tabs-normal', 'tab-no-sub']);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
```

- [ ] **Step 2: Запусти тест, убедись что падает**

Run: `node test/tabstyle.test.js`
Expected: падение с `Cannot find module '../renderer/tabstyle'` — модуля ещё нет.

- [ ] **Step 3: Не коммить**

Тест без модуля не коммитим — он поедет вместе с Task 4.

---

### Task 4: Модуль `tabstyle.js` — реализация

**Files:**
- Create: `renderer/tabstyle.js`
- Modify: `package.json:9` (цепочка `npm test`)
- Test: `test/tabstyle.test.js` (написан в Task 3)

- [ ] **Step 1: Напиши модуль**

Создай `renderer/tabstyle.js`:

```js
// tabstyle.js — tab card appearance data + pure helpers. Dual-mode: attaches to
// window.SWARM_TABSTYLE in the browser (loaded via <script> before renderer.js),
// and exports via module.exports under Node so test/tabstyle.test.js can require it.
// NO DOM here — just data and validation, so it's unit-testable in Node.
//
// Density is applied as a CLASS (it flips a batch of CSS vars declared in
// styles.css); sizes and colors are applied as CSS VARS. Keep that split — it's
// why toCssVars() emits only seven names and bodyClasses() owns the rest.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_TABSTYLE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DENSITIES = [
    { id: 'compact', name: 'Компактная' },
    { id: 'normal', name: 'Обычная' },
    { id: 'roomy', name: 'Просторная' },
  ];

  // Status colors double as the app-wide palette (statusbar, buttons read the
  // same vars). Deliberate: the alternative is duplicating five variables.
  const COLORS = [
    { key: 'accent', name: 'Активная' },
    { key: 'run', name: 'Работает' },
    { key: 'ready', name: 'Готова' },
    { key: 'waiting', name: 'Ждёт ввода' },
    { key: 'danger', name: 'Ошибка' },
  ];

  const SHOW_KEYS = ['dot', 'ctx', 'sub', 'statusFill'];

  // Colors mirror the hardcoded :root palette (styles.css:10-22) — pinned by a
  // regression test, so a change there must be mirrored here.
  const DEFAULT_TABSTYLE = {
    density: 'normal',
    show: { dot: true, ctx: true, sub: true, statusFill: true },
    labelSize: 12,
    subSize: 10,
    colors: {
      accent: '#3fd0c9',
      run: '#e0a53f',
      ready: '#4ade80',
      waiting: '#3fd0c9',
      danger: '#e05a5a',
    },
  };

  const HEX = /^#[0-9a-fA-F]{6}$/;

  function clampInt(v, lo, hi, dflt) {
    let n = parseInt(v, 10);
    if (!Number.isFinite(n)) n = dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  // Coerce any stored/garbage value into a valid tab style. Never throws.
  // Returns a deep copy, so callers can use it to fork an editable draft.
  function normalizeTabStyle(raw) {
    const d = DEFAULT_TABSTYLE;
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const rShow = (r.show && typeof r.show === 'object') ? r.show : {};
    const rColors = (r.colors && typeof r.colors === 'object') ? r.colors : {};
    const show = {};
    SHOW_KEYS.forEach(function (k) {
      show[k] = typeof rShow[k] === 'boolean' ? rShow[k] : d.show[k];
    });
    const colors = {};
    COLORS.forEach(function (c) {
      const v = rColors[c.key];
      colors[c.key] = (typeof v === 'string' && HEX.test(v)) ? v.toLowerCase() : d.colors[c.key];
    });
    return {
      density: DENSITIES.some(function (x) { return x.id === r.density; }) ? r.density : d.density,
      show: show,
      labelSize: clampInt(r.labelSize, 9, 18, d.labelSize),
      subSize: clampInt(r.subSize, 8, 14, d.subSize),
      colors: colors,
    };
  }

  // Sizes + colors → CSS custom properties. Normalizes first, so a caller can
  // pass a half-built draft without leaking garbage into the stylesheet.
  function toCssVars(style) {
    const s = normalizeTabStyle(style);
    const out = {
      '--tab-label-size': s.labelSize + 'px',
      '--tab-sub-size': s.subSize + 'px',
    };
    COLORS.forEach(function (c) { out['--' + c.key] = s.colors[c.key]; });
    return out;
  }

  // Density + visibility → class names. Order is stable (density first) so the
  // result can be compared verbatim in tests.
  function bodyClasses(style) {
    const s = normalizeTabStyle(style);
    const out = ['tabs-' + s.density];
    if (!s.show.dot) out.push('tab-no-dot');
    if (!s.show.ctx) out.push('tab-no-ctx');
    if (!s.show.sub) out.push('tab-no-sub');
    if (!s.show.statusFill) out.push('tab-no-fill');
    return out;
  }

  return { DENSITIES, COLORS, DEFAULT_TABSTYLE, normalizeTabStyle, toCssVars, bodyClasses };
});
```

- [ ] **Step 2: Запусти тест, убедись что проходит**

Run: `node test/tabstyle.test.js`
Expected: `14/14 passed`, код выхода 0.

- [ ] **Step 3: Впиши тест в цепочку npm test**

В `package.json` найди строку `"test":` и добавь `tabstyle` после `themes`:

```json
    "test": "node test/themes.test.js && node test/tabstyle.test.js && node test/keybinds.test.js && node test/preload-contract.test.js && node test/logstore.test.js && node test/updater.test.js && node test/pty-loader.test.js && node test/resume.test.js",
```

- [ ] **Step 4: Запусти всю цепочку**

Run: `npm test`
Expected: все файлы проходят, включая `tabstyle`.

- [ ] **Step 5: Commit**

```bash
git add renderer/tabstyle.js test/tabstyle.test.js package.json
git commit -m "feat(tabs): модуль tabstyle — данные и валидация визуала вкладок"
```

---

### Task 5: Проводка модуля в renderer

Модуль подключается и применяется, но на вид пока ничего не влияет: дефолты совпадают с текущим CSS, а переменные, которые он ставит, ещё не используются (кроме цветов — они переопределят `:root` теми же значениями).

**Files:**
- Modify: `renderer/index.html:70` (блок `<script>`)
- Modify: `renderer/renderer.js:112-165` (загрузка/применение) и `renderer.js:1996` (старт)

- [ ] **Step 1: Подключи скрипт**

В `renderer/index.html` найди:

```html
  <!-- In-app log ring buffer (window.SWARM_LOGSTORE). Before renderer.js. -->
  <script src="./logstore.js"></script>
```

Добавь после этих двух строк, перед `<script src="./renderer.js"></script>`:

```html
  <!-- Tab card style: density presets + pure helpers (window.SWARM_TABSTYLE). -->
  <script src="./tabstyle.js"></script>
```

- [ ] **Step 2: Возьми ссылку на API**

В `renderer/renderer.js` найди:

```js
const RESUME_API = window.SWARM_RESUME;       // Claude -n / --resume per tab
```

Добавь строку после неё:

```js
const TABSTYLE = window.SWARM_TABSTYLE;       // tab card density / visibility / colors
```

- [ ] **Step 3: Добавь load / save**

В `renderer/renderer.js` найди конец блока appearance:

```js
function saveAppearance() {
  localStorage.setItem('swarm.appearance', JSON.stringify(appearance));
}
```

Добавь после него:

```js
// Tab card look (density, which elements show, font sizes, status colors). One
// setting for all tabs, persisted as a single JSON blob in swarm.tabstyle —
// separate from swarm.appearance, which describes the TERMINAL, not the chrome.
let tabstyle = loadTabStyle();

function loadTabStyle() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('swarm.tabstyle') || 'null'); } catch (_) {}
  return TABSTYLE.normalizeTabStyle(raw);
}

function saveTabStyle() {
  localStorage.setItem('swarm.tabstyle', JSON.stringify(tabstyle));
}
```

- [ ] **Step 4: Добавь применение**

В `renderer/renderer.js` найди конец `applyAppearance`:

```js
    s.fit.fit();
  }
}
```

Добавь после него:

```js
// Every class bodyClasses() can produce — listed so apply can clear the previous
// state without touching layout-* / platform-* on the same element.
const TABSTYLE_CLASSES = [
  'tabs-compact', 'tabs-normal', 'tabs-roomy',
  'tab-no-dot', 'tab-no-ctx', 'tab-no-sub', 'tab-no-fill',
];

// Restyle every tab card at once: vars on <html>, classes on <body>. No DOM
// rebuild — the effect is pure cascade, so live and future cards both pick it up.
// No fit() here, unlike applyAppearance: the chrome's height is flexbox-driven and
// the #stage ResizeObserver (see below) refits the terminal when the bar changes.
function applyTabStyle() {
  const vars = TABSTYLE.toCssVars(tabstyle);
  for (const k of Object.keys(vars)) document.documentElement.style.setProperty(k, vars[k]);
  document.body.classList.remove(...TABSTYLE_CLASSES);
  document.body.classList.add(...TABSTYLE.bodyClasses(tabstyle));
}
```

- [ ] **Step 5: Вызови на старте**

В `renderer/renderer.js` найди строку, где восстанавливается раскладка (около `:1996`):

```js
applyLayout(localStorage.getItem('swarm.layout') || 'layout-rail');
```

Добавь перед ней:

```js
applyTabStyle();
```

Порядок важен: `applyLayout` зовёт `uiRepaint()`, и классы плотности к этому моменту должны уже стоять.

- [ ] **Step 6: Проверь контракт и порядок загрузки**

Run: `npm test`
Expected: все тесты проходят. `test/preload-contract.test.js` особенно: он падает, если `renderer.js` зовёт несуществующий метод preload — мы новых IPC не добавляли, так что должен быть зелёным.

Run: `grep -n 'tabstyle.js\|renderer.js' renderer/index.html`
Expected: `tabstyle.js` идёт раньше `renderer.js` — иначе `window.SWARM_TABSTYLE` будет `undefined` и весь UI умрёт на загрузке.

- [ ] **Step 7: Commit**

```bash
git add renderer/index.html renderer/renderer.js
git commit -m "feat(tabs): загрузка и применение tabstyle (вид пока не меняется)"
```

---

### Task 6: Хардкод вкладок переезжает в CSS-переменные

Чистый рефакторинг: значения переменных равны нынешним числам, вид не меняется ни на пиксель.

**Files:**
- Modify: `renderer/styles.css:10-23` (`:root`)
- Modify: `renderer/styles.css:172-234` (блок `.tab`)

- [ ] **Step 1: Объяви переменные в `:root`**

В `renderer/styles.css` найди конец блока `:root`:

```css
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", monospace;
}
```

Замени на:

```css
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", monospace;

  /* Габариты карточки вкладки. Значения = "обычная" плотность; body.tabs-*
     переопределяет их пачкой, а --tab-label-size / --tab-sub-size ставит JS
     (applyTabStyle) из настроек. См. renderer/tabstyle.js. */
  --tab-pad-y:      8px;
  --tab-pad-x:      10px;
  --tab-gap:        8px;
  --tab-min-w:      120px;
  --tab-max-w:      210px;
  --tab-dot-size:   8px;
  --tab-ctx-h:      4px;
  --tab-label-size: 12px;
  --tab-sub-size:   10px;
}
```

- [ ] **Step 2: Переведи `.tab` на переменные**

Найди:

```css
.tab {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px 10px;
}
.layout-top .tab {
  flex: 0 0 auto;
  width: auto;
  min-width: 120px;
  max-width: 210px;
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.tab .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ready); flex: none; margin-top: 3px; }
```

Замени на:

```css
.tab {
  display: flex;
  align-items: flex-start;
  gap: var(--tab-gap);
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: var(--tab-pad-y) var(--tab-pad-x);
}
.layout-top .tab {
  flex: 0 0 auto;
  width: auto;
  min-width: var(--tab-min-w);
  max-width: var(--tab-max-w);
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.tab .dot { width: var(--tab-dot-size); height: var(--tab-dot-size); border-radius: 50%; background: var(--ready); flex: none; margin-top: 3px; }
```

- [ ] **Step 3: Переведи текст и метр контекста**

Найди:

```css
.tab .label { color: var(--text); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
```

Замени на:

```css
.tab .label { color: var(--text); font-size: var(--tab-label-size); font-weight: 600; overflow-wrap: anywhere; }
```

Найди:

```css
.tab .sub { color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Замени на:

```css
.tab .sub { color: var(--muted); font-size: var(--tab-sub-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Найди:

```css
.tab .ctx-track { flex: 1; min-width: 26px; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
```

Замени на:

```css
.tab .ctx-track { flex: 1; min-width: 26px; height: var(--tab-ctx-h); border-radius: 2px; background: var(--border); overflow: hidden; }
```

- [ ] **Step 4: Проверь, что хардкод не остался**

Run: `grep -n 'font-size: 12px\|font-size: 10px\|padding: 8px 10px\|min-width: 120px\|max-width: 210px' renderer/styles.css`
Expected: ни одного попадания внутри блока `.tab` (строки ~172-234). Попадания в других блоках (`.group-head`, `.modal`, `#statusbar`) — нормально, их не трогаем.

Run: `npm test`
Expected: все тесты проходят.

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css
git commit -m "refactor(tabs): габариты карточки в CSS-переменных"
```

---

### Task 7: Пресеты плотности и классы видимости

Здесь появляется поведение, но включить его пока нечем — панели настроек нет, `tabstyle` держит дефолты, `body` получает `tabs-normal`. Значения `tabs-normal` обязаны совпасть с `:root`.

Селекторы пишутся через `:where(body, #set-tab-preview)`: те же правила понадобятся предпросмотру в настройках (Task 8), а `:where()` не добавляет специфичности, поэтому `#set-tab-preview` не начнёт выигрывать у `body`.

**Files:**
- Modify: `renderer/styles.css` — новый блок после `.tab:hover` (конец блока статусов, около `:234`)

- [ ] **Step 1: Добавь пресеты и классы видимости**

В `renderer/styles.css` найди:

```css
.tab:hover  { filter: brightness(1.12); opacity: 1; } /* hovering un-dims */
```

Добавь сразу после:

```css
/* --- настраиваемый вид карточек (см. renderer/tabstyle.js) ---------------- */
/* Класс плотности вешается на <body> (applyTabStyle) и на #set-tab-preview
   (предпросмотр в настройках), поэтому селекторы перечисляют оба через
   :where() — он не добавляет специфичности, так что id превью не выигрывает у
   body. tabs-normal объявлен явно, а не наследует :root: иначе превью с
   "обычной" плотностью внутри body.tabs-compact унаследовало бы компактные
   значения. Размеры шрифта пресеты не трогают — их задаёт пользователь. */
:where(body, #set-tab-preview).tabs-compact {
  --tab-pad-y: 4px;
  --tab-pad-x: 8px;
  --tab-gap: 6px;
  --tab-min-w: 90px;
  --tab-max-w: 150px;
  --tab-dot-size: 6px;
  --tab-ctx-h: 3px;
}
:where(body, #set-tab-preview).tabs-normal {
  --tab-pad-y: 8px;
  --tab-pad-x: 10px;
  --tab-gap: 8px;
  --tab-min-w: 120px;
  --tab-max-w: 210px;
  --tab-dot-size: 8px;
  --tab-ctx-h: 4px;
}
:where(body, #set-tab-preview).tabs-roomy {
  --tab-pad-y: 11px;
  --tab-pad-x: 13px;
  --tab-gap: 9px;
  --tab-min-w: 150px;
  --tab-max-w: 260px;
  --tab-dot-size: 9px;
  --tab-ctx-h: 5px;
}

/* Компактный режим кладёт содержимое карточки в строку: имя, метр контекста и
   (если включена) подпись, которую flex: 1 0 100% уносит на вторую строку. С
   выключенной подписью карточка становится однострочной — ~28px вместо ~52px.
   Размен: длинное имя обрезается многоточием вместо переноса. Полное имя
   остаётся в title карточки. */
:where(body, #set-tab-preview).tabs-compact .tab { align-items: center; }
:where(body, #set-tab-preview).tabs-compact .tab .dot { margin-top: 0; }
:where(body, #set-tab-preview).tabs-compact .tab .body {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
:where(body, #set-tab-preview).tabs-compact .tab .label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: normal;
}
:where(body, #set-tab-preview).tabs-compact .tab .ctx { flex: 0 0 auto; margin-top: 0; }
:where(body, #set-tab-preview).tabs-compact .tab .ctx-track { min-width: 20px; }
:where(body, #set-tab-preview).tabs-compact .tab .sub { flex: 1 0 100%; }

/* Видимость элементов. У .ctx !important обязателен: updateCtx() снимает атрибут
   hidden, а правило .tab .ctx[hidden] имеет ту же специфичность, что это. */
:where(body, #set-tab-preview).tab-no-dot .tab .dot { display: none; }
:where(body, #set-tab-preview).tab-no-ctx .tab .ctx { display: none !important; }
:where(body, #set-tab-preview).tab-no-sub .tab .sub { display: none; }

/* Заливка/бордер по статусу гасятся, но точка и акцентная рамка активной
   вкладки остаются — иначе активную нечем отличить. */
:where(body, #set-tab-preview).tab-no-fill .tab.status-ready,
:where(body, #set-tab-preview).tab-no-fill .tab.status-running,
:where(body, #set-tab-preview).tab-no-fill .tab.status-waiting,
:where(body, #set-tab-preview).tab-no-fill .tab.status-dead {
  background: var(--panel-2);
  border-color: var(--border);
}
```

- [ ] **Step 2: Сверь tabs-normal с :root**

Run: `grep -n -A 9 'tabs-normal {' renderer/styles.css`
Expected: семь значений (`--tab-pad-y: 8px`, `--tab-pad-x: 10px`, `--tab-gap: 8px`, `--tab-min-w: 120px`, `--tab-max-w: 210px`, `--tab-dot-size: 8px`, `--tab-ctx-h: 4px`) — те же, что ты записал в `:root` в Task 6. Расхождение здесь = вкладки едут при первом же запуске.

Run: `npm test`
Expected: все тесты проходят.

- [ ] **Step 3: Commit**

```bash
git add renderer/styles.css
git commit -m "feat(tabs): пресеты плотности и классы видимости элементов"
```

---

### Task 8: Панель «Вкладки» в настройках

Последняя задача: UI, который всем этим управляет. Правки идут в `tabDraft` и коммитятся только по Save — Esc и Cancel их выбрасывают, как у темы терминала.

**Files:**
- Modify: `renderer/renderer.js:637-643` (список `.set-tab`)
- Modify: `renderer/renderer.js:723` (новая `.set-panel` после панели `appearance`)
- Modify: `renderer/renderer.js:~860` (проводка после блока appearance)
- Modify: `renderer/renderer.js:1008` (`showTab`)
- Modify: `renderer/renderer.js:1030-1032` (`save`)
- Modify: `renderer/styles.css` (стили превью и пикеров)

- [ ] **Step 1: Зарегистрируй вкладку модалки**

В `renderer/renderer.js` найди:

```html
        <button class="set-tab" data-tab="appearance">Вид</button>
```

Замени на:

```html
        <button class="set-tab" data-tab="appearance">Вид</button>
        <button class="set-tab" data-tab="tabs">Вкладки</button>
```

- [ ] **Step 2: Добавь панель**

В `renderer/renderer.js` найди конец панели appearance:

```html
        <div class="set-field">
          <span class="set-label">Предпросмотр</span>
          <div class="term-preview" id="set-term-preview"></div>
        </div>
      </div>

      <div class="set-panel" data-panel="keys">
```

Замени на:

```html
        <div class="set-field">
          <span class="set-label">Предпросмотр</span>
          <div class="term-preview" id="set-term-preview"></div>
        </div>
      </div>

      <div class="set-panel" data-panel="tabs">
        <div class="modal-msg">Как выглядят карточки сессий. Заголовок показывается всегда.</div>
        <label class="set-field">
          <span class="set-label">Плотность</span>
          <select class="set-input" id="set-tab-density"></select>
        </label>
        <label class="set-check">
          <input type="checkbox" id="set-tab-dot" />
          <span class="set-check-tx">Точка статуса</span>
        </label>
        <label class="set-check">
          <input type="checkbox" id="set-tab-ctx" />
          <span class="set-check-tx">Метр контекста<span class="set-check-sub">Полоска и процент заполнения контекста Claude</span></span>
        </label>
        <label class="set-check">
          <input type="checkbox" id="set-tab-sub" />
          <span class="set-check-tx">Подпись статуса<span class="set-check-sub">готов / работает / завис?</span></span>
        </label>
        <label class="set-check">
          <input type="checkbox" id="set-tab-fill" />
          <span class="set-check-tx">Заливка карточки по статусу</span>
        </label>
        <div class="set-field">
          <span class="set-label">Размер заголовка</span>
          <div class="set-stepper">
            <button type="button" class="step-btn" id="set-tab-label-dec" aria-label="меньше">−</button>
            <span class="step-val" id="set-tab-label-val"></span>
            <button type="button" class="step-btn" id="set-tab-label-inc" aria-label="больше">+</button>
          </div>
        </div>
        <div class="set-field">
          <span class="set-label">Размер подписи</span>
          <div class="set-stepper">
            <button type="button" class="step-btn" id="set-tab-sub-dec" aria-label="меньше">−</button>
            <span class="step-val" id="set-tab-sub-val"></span>
            <button type="button" class="step-btn" id="set-tab-sub-inc" aria-label="больше">+</button>
          </div>
        </div>
        <div class="set-field">
          <span class="set-label">Цвета статусов</span>
          <div class="color-row" id="set-tab-colors"></div>
          <button type="button" class="set-check-btn" id="set-tab-colors-reset">Сбросить цвета</button>
          <span class="set-hint">Эти же цвета красят статус-бар и кнопки — палитра в приложении одна.</span>
        </div>
        <div class="set-field">
          <span class="set-label">Предпросмотр</span>
          <div class="tab-preview" id="set-tab-preview"></div>
        </div>
      </div>

      <div class="set-panel" data-panel="keys">
```

- [ ] **Step 3: Напиши проводку**

В `renderer/renderer.js` найди конец проводки appearance:

```js
  blinkI.addEventListener('change', () => { draft.cursorBlink = blinkI.checked; });
```

Добавь после неё:

```js
  // Tabs panel. Same draft pattern as appearance: edits land in tabDraft and only
  // commit on Save. normalizeTabStyle doubles as the deep copy — a spread would
  // share the nested show/colors objects with the live tabstyle and leak edits.
  const tabDraft = TABSTYLE.normalizeTabStyle(tabstyle);
  const densitySel = overlay.querySelector('#set-tab-density');
  const showInputs = {
    dot: overlay.querySelector('#set-tab-dot'),
    ctx: overlay.querySelector('#set-tab-ctx'),
    sub: overlay.querySelector('#set-tab-sub'),
    statusFill: overlay.querySelector('#set-tab-fill'),
  };
  const tabLabelVal = overlay.querySelector('#set-tab-label-val');
  const tabSubVal = overlay.querySelector('#set-tab-sub-val');
  const colorRow = overlay.querySelector('#set-tab-colors');
  const tabPreviewEl = overlay.querySelector('#set-tab-preview');

  TABSTYLE.DENSITIES.forEach((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    densitySel.appendChild(o);
  });
  densitySel.value = tabDraft.density;

  Object.keys(showInputs).forEach((k) => { showInputs[k].checked = tabDraft.show[k]; });

  // Two sample cards cover the whole surface: an active/running one (accent ring
  // + run fill) and an idle one. Written once — renderTabPreview only restyles.
  tabPreviewEl.innerHTML =
    `<div class="tab active status-running">
       <span class="dot"></span>
       <span class="body">
         <span class="label">api</span>
         <span class="ctx ctx-mid"><span class="ctx-track"><span class="ctx-fill" style="width:62%"></span></span><span class="ctx-num">62%</span></span>
         <span class="sub">работает</span>
       </span>
     </div>
     <div class="tab status-ready">
       <span class="dot"></span>
       <span class="body">
         <span class="label">web</span>
         <span class="ctx ctx-lo"><span class="ctx-track"><span class="ctx-fill" style="width:14%"></span></span><span class="ctx-num">14%</span></span>
         <span class="sub">готов</span>
       </span>
     </div>`;

  function renderTabPreview() {
    const vars = TABSTYLE.toCssVars(tabDraft);
    for (const k of Object.keys(vars)) tabPreviewEl.style.setProperty(k, vars[k]);
    // layout-top pins the card look regardless of the app's current layout —
    // .layout-top .tab is what gives a tab its border/background.
    tabPreviewEl.className = 'tab-preview layout-top ' + TABSTYLE.bodyClasses(tabDraft).join(' ');
    tabLabelVal.textContent = tabDraft.labelSize;
    tabSubVal.textContent = tabDraft.subSize;
  }

  function renderColorPickers() {
    colorRow.innerHTML = '';
    TABSTYLE.COLORS.forEach((c) => {
      const cell = document.createElement('label');
      cell.className = 'color-cell';
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = tabDraft.colors[c.key];
      inp.addEventListener('input', () => {
        tabDraft.colors[c.key] = inp.value;
        renderTabPreview();
      });
      const name = document.createElement('span');
      name.textContent = c.name;
      cell.appendChild(inp);
      cell.appendChild(name);
      colorRow.appendChild(cell);
    });
  }

  renderColorPickers();
  renderTabPreview();

  densitySel.addEventListener('change', () => {
    tabDraft.density = densitySel.value;
    renderTabPreview();
  });
  Object.keys(showInputs).forEach((k) => {
    showInputs[k].addEventListener('change', () => {
      tabDraft.show[k] = showInputs[k].checked;
      renderTabPreview();
    });
  });
  const setTabLabel = (n) => { tabDraft.labelSize = Math.max(9, Math.min(18, n)); renderTabPreview(); };
  const setTabSub = (n) => { tabDraft.subSize = Math.max(8, Math.min(14, n)); renderTabPreview(); };
  overlay.querySelector('#set-tab-label-dec').addEventListener('click', () => setTabLabel(tabDraft.labelSize - 1));
  overlay.querySelector('#set-tab-label-inc').addEventListener('click', () => setTabLabel(tabDraft.labelSize + 1));
  overlay.querySelector('#set-tab-sub-dec').addEventListener('click', () => setTabSub(tabDraft.subSize - 1));
  overlay.querySelector('#set-tab-sub-inc').addEventListener('click', () => setTabSub(tabDraft.subSize + 1));
  overlay.querySelector('#set-tab-colors-reset').addEventListener('click', () => {
    tabDraft.colors = { ...TABSTYLE.DEFAULT_TABSTYLE.colors };
    renderColorPickers();
    renderTabPreview();
  });
```

- [ ] **Step 4: Впиши вкладку в showTab**

В `renderer/renderer.js` найди:

```js
  showTab(['notify', 'appearance', 'keys', 'updates'].includes(tab) ? tab : 'launch');
```

Замени на:

```js
  showTab(['notify', 'appearance', 'tabs', 'keys', 'updates'].includes(tab) ? tab : 'launch');
```

- [ ] **Step 5: Коммить в save**

В `renderer/renderer.js` найди:

```js
    appearance = { ...draft };
    saveAppearance();
    applyAppearance();
```

Замени на:

```js
    appearance = { ...draft };
    saveAppearance();
    applyAppearance();
    tabstyle = TABSTYLE.normalizeTabStyle(tabDraft);
    saveTabStyle();
    applyTabStyle();
```

- [ ] **Step 6: Добавь стили панели**

В `renderer/styles.css` найди:

```css
.set-stepper { display: flex; align-items: center; gap: 12px; }
```

Добавь после:

```css
/* Предпросмотр карточек в настройках. Id-специфичность здесь нужна, чтобы
   перебить .layout-top .tab: превью само носит класс layout-top, но карточки в
   нём должны делить ширину поровну, а не жить по --tab-min-w/--tab-max-w. */
.tab-preview {
  display: flex;
  gap: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
}
#set-tab-preview .tab { flex: 1 1 0; min-width: 0; max-width: none; cursor: default; }

.color-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.color-cell { display: inline-flex; flex-direction: column; align-items: center; gap: 4px; font-size: 10px; color: var(--muted); cursor: pointer; }
.color-cell input[type="color"] {
  width: 38px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  cursor: pointer;
}
```

- [ ] **Step 7: Проверь**

Run: `npm test`
Expected: все тесты проходят, включая `preload-contract` (новых IPC мы не добавляли).

Run: `node -e "new Function(require('fs').readFileSync('renderer/renderer.js','utf8')); console.log('syntax ok')"`
Expected: `syntax ok` — модалка собирается шаблонной строкой, и незакрытая кавычка ломает весь UI молча.

Перечитай свою правку и сверь три вещи: `tabDraft` объявлен до первого использования в `renderTabPreview`; `#set-tab-preview` есть и в HTML панели, и в `overlay.querySelector`; в `save()` идёт `normalizeTabStyle(tabDraft)`, а не `{ ...tabDraft }` (спред разделил бы вложенные объекты с драфтом).

- [ ] **Step 8: Commit**

```bash
git add renderer/renderer.js renderer/styles.css
git commit -m "feat(tabs): панель настроек визуала вкладок с предпросмотром"
```

---

## Про CHANGELOG

Руками его не трогай. `npm run release` собирает секцию версии из коммитов с
последнего тега (`scripts/release.mjs:56-66`), поэтому changelog этой работы —
это восемь сообщений коммитов выше. Пиши их так, чтобы их можно было прочитать
как готовую запись.

---

## Финальная проверка

- [ ] Run: `npm test` — вся цепочка зелёная, включая `test/tabstyle.test.js`.
- [ ] Run: `git log --oneline -8` — восемь коммитов, по одному на задачу.
- [ ] Скажи пользователю, что визуальную проверку надо сделать вручную при следующем запуске приложения, и что проверить: дефолты не изменили вид; переключение плотности; галочки видимости; свёрнутая группа в top-раскладке; кнопка «+» в top-раскладке; Esc в настройках откатывает правки.
