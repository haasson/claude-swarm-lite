# Тема терминала — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать пользователю сменить палитру терминала (6 пресетов) и настроить шрифт/курсор — глобально, с мгновенным применением к открытым вкладкам; плюс конфирм при закрытии приложения.

**Architecture:** Данные тем и вся чистая логика (валидация настроек, выбор темы) живут в новом `renderer/themes.js` (двойной режим: браузер-глобал `window.SWARM_THEMES` + CommonJS для юнит-тестов). `renderer.js` читает эти настройки в `makeXterm()` для новых вкладок и в `applyAppearance()` для живых. UI — третья вкладка «Вид» в модалке настроек. Конфирм закрытия — перехват `win.on('close')` в `main.js` с нативным диалогом.

**Tech Stack:** Electron, xterm.js 5.5 (UMD-глобалы), ванильный JS/CSS, node-тесты без фреймворка (`assert`).

**ВАЖНО — ограничение окружения:** у пользователя приложение уже запущено с живыми агентами в других вкладках. **Не запускать `npm start` и не убивать процесс.** Живая проверка UI — только когда пользователь сам перезапустит. Верификация в плане — через юнит-тесты (`npm test`) и чтение кода.

---

## Структура файлов

- **Создать `renderer/themes.js`** — 6 пресетов палитр, списки шрифтов/курсоров, дефолты, чистые функции `getTheme` / `normalizeAppearance`. Единственный источник данных и валидации внешнего вида.
- **Создать `test/themes.test.js`** — юнит-тесты валидности пресетов и нормализации настроек.
- **Изменить `renderer/index.html`** — подключить `themes.js` перед `renderer.js`.
- **Изменить `renderer/renderer.js`** — `loadAppearance` / `saveAppearance` / `applyAppearance`, чтение настроек в `makeXterm`, вкладка «Вид» в `showSettingsModal`.
- **Изменить `renderer/styles.css`** — стили сетки тем, степпера, предпросмотра.
- **Изменить `main.js`** — конфирм при закрытии окна.
- **Изменить `package.json`** — прогонять оба тест-файла.

---

## Task 1: Данные тем и чистая логика (`renderer/themes.js`)

**Files:**
- Create: `renderer/themes.js`
- Test: `test/themes.test.js`
- Modify: `package.json` (скрипт `test`)

- [ ] **Step 1: Написать падающий тест**

Create `test/themes.test.js`:

```js
// Plain-node tests for the terminal theme presets + appearance normalization
// (no framework: run `node test/themes.test.js`). themes.js is dual-mode
// (browser global + CommonJS), so it can be required straight into Node.
const assert = require('assert');
const T = require('../renderer/themes');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const HEX = /^#[0-9a-fA-F]{6}$/;
const CORE = ['background', 'foreground', 'cursor', 'selectionBackground'];
const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

test('exposes exactly 6 themes', () => {
  assert.strictEqual(T.THEMES.length, 6);
});

test('every theme has a non-empty id and name; ids are unique', () => {
  const ids = new Set();
  for (const t of T.THEMES) {
    assert.ok(t.id && typeof t.id === 'string', 'id');
    assert.ok(t.name && typeof t.name === 'string', 'name');
    assert.ok(!ids.has(t.id), 'duplicate id: ' + t.id);
    ids.add(t.id);
  }
});

test('every theme has all core + 16 ANSI keys as valid hex', () => {
  for (const t of T.THEMES) {
    for (const k of [...CORE, ...ANSI]) {
      assert.ok(HEX.test(t.xterm[k]), `${t.id}.${k} = ${t.xterm[k]}`);
    }
  }
});

test('swarm-dark preserves the current hardcoded defaults (regression)', () => {
  const x = T.getTheme('swarm-dark').xterm;
  assert.strictEqual(x.background, '#0d0f12');
  assert.strictEqual(x.foreground, '#c9d1d9');
  assert.strictEqual(x.cursor, '#3fd0c9');
  assert.strictEqual(x.selectionBackground, '#2b3640');
});

test('getTheme returns null for unknown id', () => {
  assert.strictEqual(T.getTheme('nope'), null);
});

test('normalizeAppearance fills defaults from empty/garbage input', () => {
  const a = T.normalizeAppearance(null);
  assert.strictEqual(a.theme, 'swarm-dark');
  assert.strictEqual(a.fontSize, 13);
  assert.strictEqual(a.cursorStyle, 'block');
  assert.strictEqual(a.cursorBlink, true);
  assert.ok(a.fontFamily.length > 0);
});

test('normalizeAppearance falls back on unknown theme', () => {
  assert.strictEqual(T.normalizeAppearance({ theme: 'bogus' }).theme, 'swarm-dark');
});

test('normalizeAppearance clamps fontSize to 10..20', () => {
  assert.strictEqual(T.normalizeAppearance({ fontSize: 4 }).fontSize, 10);
  assert.strictEqual(T.normalizeAppearance({ fontSize: 99 }).fontSize, 20);
  assert.strictEqual(T.normalizeAppearance({ fontSize: '15' }).fontSize, 15);
});

test('normalizeAppearance rejects a bad cursorStyle', () => {
  assert.strictEqual(T.normalizeAppearance({ cursorStyle: 'spiral' }).cursorStyle, 'block');
  assert.strictEqual(T.normalizeAppearance({ cursorStyle: 'bar' }).cursorStyle, 'bar');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
```

- [ ] **Step 2: Прогнать тест — убедиться, что падает**

Run: `node test/themes.test.js`
Expected: FAIL — `Cannot find module '../renderer/themes'`.

- [ ] **Step 3: Создать `renderer/themes.js`**

Create `renderer/themes.js`:

```js
// themes.js — terminal appearance data + pure helpers. Dual-mode: attaches to
// window.SWARM_THEMES in the browser (loaded via <script> before renderer.js),
// and exports via module.exports under Node so test/themes.test.js can require it.
// NO DOM / xterm here — just data and validation, so it's unit-testable in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_THEMES = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Each preset is a full xterm ITheme: the 4 core keys + 16 ANSI colors.
  // swarm-dark reproduces today's hardcoded look (its ANSI set is xterm's own
  // Tango defaults, which the app rendered before — so nothing shifts visually).
  const THEMES = [
    {
      id: 'swarm-dark', name: 'Swarm Dark',
      xterm: {
        background: '#0d0f12', foreground: '#c9d1d9', cursor: '#3fd0c9',
        cursorAccent: '#0d0f12', selectionBackground: '#2b3640',
        black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000',
        blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
        brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234',
        brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8',
        brightCyan: '#34e2e2', brightWhite: '#eeeeec',
      },
    },
    {
      id: 'light', name: 'Light',
      xterm: {
        background: '#ffffff', foreground: '#24292e', cursor: '#044289',
        cursorAccent: '#ffffff', selectionBackground: '#c8e1ff',
        black: '#24292e', red: '#d73a49', green: '#22863a', yellow: '#b08800',
        blue: '#0366d6', magenta: '#6f42c1', cyan: '#1b7c83', white: '#6a737d',
        brightBlack: '#959da5', brightRed: '#cb2431', brightGreen: '#28a745',
        brightYellow: '#dbab09', brightBlue: '#2188ff', brightMagenta: '#8a63d2',
        brightCyan: '#3192aa', brightWhite: '#d1d5da',
      },
    },
    {
      id: 'solarized-dark', name: 'Solarized Dark',
      xterm: {
        background: '#002b36', foreground: '#839496', cursor: '#93a1a1',
        cursorAccent: '#002b36', selectionBackground: '#073642',
        black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
        blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
        brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#657b83',
        brightYellow: '#839496', brightBlue: '#93a1a1', brightMagenta: '#6c71c4',
        brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
      },
    },
    {
      id: 'dracula', name: 'Dracula',
      xterm: {
        background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
        cursorAccent: '#282a36', selectionBackground: '#44475a',
        black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
        blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
        brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
        brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
        brightCyan: '#a4ffff', brightWhite: '#ffffff',
      },
    },
    {
      id: 'nord', name: 'Nord',
      xterm: {
        background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9',
        cursorAccent: '#2e3440', selectionBackground: '#434c5e',
        black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
        blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
        brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
        brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
        brightCyan: '#8fbcbb', brightWhite: '#eceff4',
      },
    },
    {
      id: 'gruvbox-dark', name: 'Gruvbox Dark',
      xterm: {
        background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2',
        cursorAccent: '#282828', selectionBackground: '#504945',
        black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
        blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
        brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
        brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
        brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
      },
    },
  ];

  // Font stacks offered in the picker. Values are stored verbatim into
  // appearance.fontFamily and handed straight to xterm's fontFamily option.
  const FONT_FAMILIES = [
    { name: 'Системный моно', value: 'ui-monospace, "SF Mono", Menlo, monospace' },
    { name: 'Menlo', value: 'Menlo, monospace' },
    { name: 'Monaco', value: 'Monaco, monospace' },
    { name: 'JetBrains Mono', value: '"JetBrains Mono", ui-monospace, monospace' },
    { name: 'Courier', value: '"Courier New", Courier, monospace' },
  ];

  const CURSOR_STYLES = [
    { id: 'block', name: 'Блок' },
    { id: 'bar', name: 'Полоса' },
    { id: 'underline', name: 'Подчёркивание' },
  ];

  const DEFAULT_APPEARANCE = {
    theme: 'swarm-dark',
    fontSize: 13,
    fontFamily: FONT_FAMILIES[0].value,
    cursorStyle: 'block', // xterm's own default when unset — keeps today's look
    cursorBlink: true,
  };

  function getTheme(id) {
    return THEMES.find(function (t) { return t.id === id; }) || null;
  }

  // Coerce any stored/garbage value into a valid appearance object. Never throws.
  function normalizeAppearance(raw) {
    const d = DEFAULT_APPEARANCE;
    const r = (raw && typeof raw === 'object') ? raw : {};
    let fontSize = parseInt(r.fontSize, 10);
    if (!Number.isFinite(fontSize)) fontSize = d.fontSize;
    fontSize = Math.max(10, Math.min(20, fontSize));
    return {
      theme: getTheme(r.theme) ? r.theme : d.theme,
      fontSize: fontSize,
      fontFamily: (typeof r.fontFamily === 'string' && r.fontFamily.trim()) ? r.fontFamily : d.fontFamily,
      cursorStyle: ['block', 'bar', 'underline'].includes(r.cursorStyle) ? r.cursorStyle : d.cursorStyle,
      cursorBlink: typeof r.cursorBlink === 'boolean' ? r.cursorBlink : d.cursorBlink,
    };
  }

  return { THEMES, FONT_FAMILIES, CURSOR_STYLES, DEFAULT_APPEARANCE, getTheme, normalizeAppearance };
});
```

- [ ] **Step 4: Прогнать тест — убедиться, что проходит**

Run: `node test/themes.test.js`
Expected: PASS — `9/9 passed`.

- [ ] **Step 5: Прогонять оба тест-файла из `npm test`**

Modify `package.json`, строка со скриптом `test`:

```json
    "test": "node test/detector.test.js && node test/themes.test.js",
```

Run: `npm test`
Expected: оба файла отрабатывают, обе сводки `passed`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add renderer/themes.js test/themes.test.js package.json
git commit -m "feat(тема): пресеты палитр + чистая нормализация настроек вида"
```

---

## Task 2: Применение настроек к терминалам (`renderer.js` + `index.html`)

**Files:**
- Modify: `renderer/index.html:61` (добавить `<script>`)
- Modify: `renderer/renderer.js:176-193` (`makeXterm`) + новый блок рядом

Верификация — чтением кода и `npm test` (Task 1 покрывает логику нормализации). Живьём проверит пользователь после перезапуска. **Приложение не запускать.**

- [ ] **Step 1: Подключить themes.js перед renderer.js**

Modify `renderer/index.html`. Найти:

```html
  <script src="./vendor/addon-fit.js"></script>
  <script src="./renderer.js"></script>
```

Заменить на:

```html
  <script src="./vendor/addon-fit.js"></script>
  <!-- Terminal theme presets + appearance helpers (window.SWARM_THEMES). Must
       load before renderer.js, which reads it in makeXterm/applyAppearance. -->
  <script src="./themes.js"></script>
  <script src="./renderer.js"></script>
```

- [ ] **Step 2: Ввести состояние внешнего вида в renderer.js**

Modify `renderer/renderer.js`. Найти строку 8-9:

```js
const { Terminal } = window;                 // UMD global from xterm.js
const { FitAddon } = window.FitAddon;        // UMD global from addon-fit
```

Добавить сразу после неё:

```js
const APPEARANCE = window.SWARM_THEMES;       // terminal theme presets + helpers

// Global terminal appearance (theme + font + cursor). One setting for all tabs,
// persisted as a single JSON blob in localStorage (see swarm.appearance). Read by
// makeXterm() for NEW tabs and by applyAppearance() to restyle LIVE tabs on save.
let appearance = loadAppearance();

function loadAppearance() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('swarm.appearance') || 'null'); } catch (_) {}
  return APPEARANCE.normalizeAppearance(raw);
}

function saveAppearance() {
  localStorage.setItem('swarm.appearance', JSON.stringify(appearance));
}

// Restyle every LIVE terminal in place, then refit — a font-size change alters the
// cell grid, so the pty must be resized (same reason applyLayout refits).
function applyAppearance() {
  const xt = APPEARANCE.getTheme(appearance.theme).xterm;
  for (const s of sessions.values()) {
    s.term.options.theme = xt;
    s.term.options.fontSize = appearance.fontSize;
    s.term.options.fontFamily = appearance.fontFamily;
    s.term.options.cursorStyle = appearance.cursorStyle;
    s.term.options.cursorBlink = appearance.cursorBlink;
    s.fit.fit();
  }
}
```

- [ ] **Step 3: Читать настройки в makeXterm**

Modify `renderer/renderer.js`, функция `makeXterm` (строки 176-193). Заменить тело `new Terminal({...})`:

```js
function makeXterm() {
  const term = new Terminal({
    cursorBlink: appearance.cursorBlink,
    cursorStyle: appearance.cursorStyle,
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    lineHeight: 1.15,
    scrollback: 10000,
    theme: APPEARANCE.getTheme(appearance.theme).xterm,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm test`
Expected: exit 0, обе сводки `passed` (регрессий нет — логика та же).

- [ ] **Step 5: Проверить синтаксис renderer.js без запуска приложения**

Run: `node --check renderer/renderer.js`
Expected: без вывода, exit 0 (файл парсится; `window`-глобалы не выполняются при --check).

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/renderer.js
git commit -m "feat(тема): применять сохранённый вид к новым и живым вкладкам"
```

---

## Task 3: Вкладка «Вид» в настройках (`renderer.js` + `styles.css`)

**Files:**
- Modify: `renderer/renderer.js`, функция `showSettingsModal` (строки 433-559)
- Modify: `renderer/styles.css` (в конец файла)

Верификация — `node --check` + чтение. Живьём проверит пользователь. **Приложение не запускать.**

- [ ] **Step 1: Добавить кнопку-вкладку «Вид»**

Modify `renderer/renderer.js`. Найти в `showSettingsModal`:

```js
      <div class="set-tabs" role="tablist">
        <button class="set-tab" data-tab="launch">Запуск</button>
        <button class="set-tab" data-tab="notify">Уведомления</button>
      </div>
```

Заменить на:

```js
      <div class="set-tabs" role="tablist">
        <button class="set-tab" data-tab="launch">Запуск</button>
        <button class="set-tab" data-tab="notify">Уведомления</button>
        <button class="set-tab" data-tab="appearance">Вид</button>
      </div>
```

- [ ] **Step 2: Добавить панель «Вид»**

Modify `renderer/renderer.js`. Найти закрытие панели уведомлений и кнопки действий:

```js
          <label class="set-check">
            <input type="checkbox" id="set-notify-sound" />
            <span class="set-check-tx">Звук</span>
          </label>
        </div>
      </div>

      <div class="modal-actions">
```

Заменить на (добавляется третья панель перед `.modal-actions`):

```js
          <label class="set-check">
            <input type="checkbox" id="set-notify-sound" />
            <span class="set-check-tx">Звук</span>
          </label>
        </div>
      </div>

      <div class="set-panel" data-panel="appearance">
        <div class="modal-msg">Оформление терминала. Применяется ко <b>всем</b> вкладкам сразу.</div>
        <div class="set-field">
          <span class="set-label">Тема</span>
          <div class="theme-grid" id="set-theme-grid"></div>
        </div>
        <div class="set-field">
          <span class="set-label">Размер шрифта</span>
          <div class="set-stepper">
            <button type="button" class="step-btn" id="set-font-dec" aria-label="меньше">−</button>
            <span class="step-val" id="set-font-val"></span>
            <button type="button" class="step-btn" id="set-font-inc" aria-label="больше">+</button>
          </div>
        </div>
        <label class="set-field">
          <span class="set-label">Шрифт</span>
          <select class="set-input" id="set-font-family"></select>
        </label>
        <label class="set-field">
          <span class="set-label">Курсор</span>
          <select class="set-input" id="set-cursor-style"></select>
        </label>
        <label class="set-check">
          <input type="checkbox" id="set-cursor-blink" />
          <span class="set-check-tx">Мигание курсора</span>
        </label>
        <div class="set-field">
          <span class="set-label">Предпросмотр</span>
          <div class="term-preview" id="set-term-preview"></div>
        </div>
      </div>

      <div class="modal-actions">
```

- [ ] **Step 3: Подключить вкладку «Вид» в переключатель панелей**

Modify `renderer/renderer.js`. Найти внутри `showSettingsModal` строку выбора стартовой вкладки:

```js
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  showTab(tab === 'notify' ? 'notify' : 'launch');
```

Заменить на:

```js
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  showTab(['notify', 'appearance'].includes(tab) ? tab : 'launch');
```

- [ ] **Step 4: Собрать UI вида и завести живой предпросмотр**

Modify `renderer/renderer.js`. Найти в `showSettingsModal` конец блока настройки уведомлений — сразу перед секцией `// Tab switching.`:

```js
  syncNotify();
  onI.addEventListener('change', syncNotify);

  // Tab switching.
```

Вставить между ними блок сборки вкладки «Вид»:

```js
  syncNotify();
  onI.addEventListener('change', syncNotify);

  // Appearance panel. Edits accumulate in `draft` (a copy of the live appearance)
  // and only commit on Save — Cancel/Esc discards them. A small preview strip
  // reflects the draft immediately, before saving.
  const draft = { ...appearance };
  const grid = overlay.querySelector('#set-theme-grid');
  const fontVal = overlay.querySelector('#set-font-val');
  const fontDec = overlay.querySelector('#set-font-dec');
  const fontInc = overlay.querySelector('#set-font-inc');
  const familySel = overlay.querySelector('#set-font-family');
  const cursorSel = overlay.querySelector('#set-cursor-style');
  const blinkI = overlay.querySelector('#set-cursor-blink');
  const preview = overlay.querySelector('#set-term-preview');

  function renderThemeSwatch(t) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-swatch' + (t.id === draft.theme ? ' active' : '');
    b.dataset.theme = t.id;
    b.title = t.name;
    const pal = ['green', 'yellow', 'blue', 'magenta', 'cyan'];
    b.innerHTML =
      `<span class="theme-pal" style="background:${t.xterm.background}">` +
      pal.map((k) => `<i style="background:${t.xterm[k]}"></i>`).join('') +
      `</span><span class="theme-name"></span>`;
    b.querySelector('.theme-name').textContent = t.name;
    b.addEventListener('click', () => {
      draft.theme = t.id;
      grid.querySelectorAll('.theme-swatch').forEach((el) =>
        el.classList.toggle('active', el.dataset.theme === t.id));
      renderPreview();
    });
    return b;
  }
  APPEARANCE.THEMES.forEach((t) => grid.appendChild(renderThemeSwatch(t)));

  APPEARANCE.FONT_FAMILIES.forEach((f) => {
    const o = document.createElement('option');
    o.value = f.value;
    o.textContent = f.name;
    familySel.appendChild(o);
  });
  familySel.value = draft.fontFamily; // no-op if the stored stack isn't in the list

  APPEARANCE.CURSOR_STYLES.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    cursorSel.appendChild(o);
  });
  cursorSel.value = draft.cursorStyle;
  blinkI.checked = draft.cursorBlink;

  function renderPreview() {
    const xt = APPEARANCE.getTheme(draft.theme).xterm;
    preview.style.background = xt.background;
    preview.style.color = xt.foreground;
    preview.style.fontFamily = draft.fontFamily;
    preview.style.fontSize = draft.fontSize + 'px';
    fontVal.textContent = draft.fontSize;
    const cur = draft.cursorStyle === 'bar' ? '▏' : draft.cursorStyle === 'underline' ? '_' : '█';
    preview.innerHTML =
      `<span style="color:${xt.green}">claude</span> ` +
      `<span style="color:${xt.yellow}">--help</span> ` +
      `<span style="color:${xt.blue}">✓</span> ` +
      `<span class="prev-cur" style="color:${xt.cursor}">${cur}</span>`;
  }
  renderPreview();

  const setFont = (n) => { draft.fontSize = Math.max(10, Math.min(20, n)); renderPreview(); };
  fontDec.addEventListener('click', () => setFont(draft.fontSize - 1));
  fontInc.addEventListener('click', () => setFont(draft.fontSize + 1));
  familySel.addEventListener('change', () => { draft.fontFamily = familySel.value; renderPreview(); });
  cursorSel.addEventListener('change', () => { draft.cursorStyle = cursorSel.value; renderPreview(); });
  blinkI.addEventListener('change', () => { draft.cursorBlink = blinkI.checked; });

  // Tab switching.
```

- [ ] **Step 5: Коммитить черновик вида при сохранении**

Modify `renderer/renderer.js`. Найти внутри `showSettingsModal` функцию `save` — конкретно строку перед `close();`:

```js
    applyNotify(onI.checked); // master switch (persists swarm.notify)
    close();
  };
```

Заменить на:

```js
    applyNotify(onI.checked); // master switch (persists swarm.notify)
    appearance = { ...draft };
    saveAppearance();
    applyAppearance();
    close();
  };
```

- [ ] **Step 6: Добавить стили вкладки «Вид»**

Modify `renderer/styles.css`, в конец файла:

```css
/* --- settings: appearance tab -------------------------------------------- */
.theme-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.theme-swatch {
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; text-align: left; color: var(--text);
}
.theme-swatch:hover { border-color: var(--muted); }
.theme-swatch.active { border-color: var(--accent); }
.theme-pal { display: flex; height: 22px; border-radius: 5px; overflow: hidden; }
.theme-pal i { flex: 1; }
.theme-name { font-size: 11px; color: var(--muted); }
.theme-swatch.active .theme-name { color: var(--accent); }

.set-stepper { display: flex; align-items: center; gap: 12px; }
.step-btn {
  width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel-2); color: var(--text); font-size: 16px; line-height: 1;
  cursor: pointer;
}
.step-btn:hover { border-color: var(--accent); color: var(--accent); }
.step-val { min-width: 28px; text-align: center; font-variant-numeric: tabular-nums; color: var(--text); }

.term-preview {
  padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border);
  font-family: var(--mono); line-height: 1.4; white-space: nowrap; overflow: hidden;
}
.term-preview .prev-cur { font-weight: 700; }
```

- [ ] **Step 7: Проверить синтаксис без запуска**

Run: `node --check renderer/renderer.js`
Expected: без вывода, exit 0.

- [ ] **Step 8: Commit**

```bash
git add renderer/renderer.js renderer/styles.css
git commit -m "feat(тема): вкладка «Вид» в настройках — пресеты, шрифт, курсор, предпросмотр"
```

---

## Task 4: Конфирм при закрытии приложения (`main.js`)

**Files:**
- Modify: `main.js`, функция `createWindow` (строки 98-132)

Верификация — `node --check main.js` + чтение. Живьём проверит пользователь. **Приложение не запускать.**

- [ ] **Step 1: Добавить флаг разрешённого выхода**

Modify `main.js`. Найти:

```js
/** @type {BrowserWindow | null} */
let win = null;
```

Заменить на:

```js
/** @type {BrowserWindow | null} */
let win = null;
// Set once the user confirms the close dialog, so the re-issued win.close() (or a
// Cmd+Q that follows) passes through instead of re-prompting.
let allowClose = false;
```

- [ ] **Step 2: Перехватить закрытие окна и спросить подтверждение**

Modify `main.js`. Найти в `createWindow`:

```js
  win.on('closed', () => {
```

Вставить перед ней:

```js
  // Confirm before the window closes — closing it kills every `claude` child
  // (see the 'closed' handler), so an accidental ⌘Q / red-button click would drop
  // live agents. Native sync dialog: simplest reliable gate in the main process.
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    const n = sessions.size;
    const message = n > 0
      ? `Закрыть Claude Swarm? Сейчас запущено сессий: ${n}. Все агенты завершатся.`
      : 'Закрыть Claude Swarm?';
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Отмена', 'Закрыть'],
      defaultId: 0,
      cancelId: 0,
      title: 'Закрытие приложения',
      message,
    });
    if (choice === 1) { allowClose = true; win.close(); }
  });

```

- [ ] **Step 3: Проверить синтаксис без запуска**

Run: `node --check main.js`
Expected: без вывода, exit 0.

- [ ] **Step 4: Финальный прогон тестов**

Run: `npm test`
Expected: exit 0, обе сводки `passed`.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(окно): подтверждение при закрытии приложения (агенты завершатся)"
```

---

## Финальная проверка (после всех задач)

- [ ] `npm test` — зелёный.
- [ ] `node --check renderer/renderer.js && node --check main.js` — оба чисто.
- [ ] `git status` — рабочее дерево чистое, все правки закоммичены.
- [ ] Сообщить пользователю: изменения в силе после **его** перезапуска приложения (мы не перезапускаем — живут агенты). Живая проверка: ⚙ → «Вид» → сменить тему/шрифт/курсор (открытые вкладки перекрашиваются сразу); ⌘Q → должен появиться конфирм.

## Заметки по границам и рискам

- **Регресс-нейтральность:** дефолт `swarm-dark` + `cursorStyle:'block'` воспроизводят текущий вид; ANSI-палитра `swarm-dark` — это дефолты xterm (Tango), которые приложение и так рисовало. Юнит-тест стережёт 4 ключевых цвета.
- **`fit.fit()` после смены размера** обязателен — иначе терминал обрежет строку/колонки (та же причина, что в `applyLayout`).
- **Хранение шрифта строкой-стеком:** если пользователь когда-то сохранил стек не из списка, `familySel.value=` просто не выберет пункт, но сам стек продолжит применяться — данные не теряются.
- **Нативный диалог закрытия** блокирующий (`showMessageBoxSync`) — намеренно: это самый надёжный гейт в main-процессе, не требует IPC и не гонок с рендерером.
