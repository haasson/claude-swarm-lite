# Настройки визуала вкладок

Дата: 2026-07-15

## Цель

Дать пользователю управление внешним видом карточек вкладок: что на них
показано, насколько они плотные, какого размера текст и какими цветами
раскрашены статусы. Плюс две правки существующего поведения — свёрнутая группа
перестаёт растягиваться по высоте соседей, а кнопка «новая сессия» в верхней
раскладке ужимается до иконки.

Задача, которую это решает: на 4-5 вкладках верхний бар съедает заметную часть
окна, а половина того, что на карточке, конкретному пользователю не нужна.
Сейчас выбора нет — вид захардкожен в `styles.css`.

## Что настраивается

Один глобальный набор параметров на все вкладки. Per-tab настроек нет: они
потребовали бы UI на каждой карточке и хранения в `swarm.tabs`, а выигрыш
сомнителен — вкладки смотрят одним взглядом, и разнобой мешает.

| Параметр | Значения | Дефолт |
|---|---|---|
| Плотность | `compact` / `normal` / `roomy` | `normal` |
| Точка статуса `.dot` | вкл/выкл | вкл |
| Метр контекста `.ctx` | вкл/выкл | вкл |
| Подпись статуса `.sub` | вкл/выкл | вкл |
| Заливка и бордер по статусу | вкл/выкл | вкл |
| Размер заголовка | 9..18 px | 12 |
| Размер подписи | 8..14 px | 10 |
| Цвета `accent`, `ready`, `run`, `waiting`, `danger` | hex | текущие из `:root` |

Заголовок вкладки не отключается — без него карточка перестаёт быть вкладкой.

Дефолты воспроизводят нынешний вид ровно. Пользователь, который не пойдёт в
настройки, изменений не заметит.

## Архитектура

### Модуль `renderer/tabstyle.js` (новый)

UMD-обёртка по образцу `themes.js:5-9`: в браузере вешается на
`window.SWARM_TABSTYLE`, под Node отдаётся через `module.exports` ради тестов.
Ни DOM, ни xterm внутри — только данные и чистые функции.

Экспорт: `{ DENSITIES, DEFAULT_TABSTYLE, normalizeTabStyle, toCssVars, bodyClasses }`.

```js
DEFAULT_TABSTYLE = {
  density: 'normal',
  show: { dot: true, ctx: true, sub: true, statusFill: true },
  labelSize: 12,
  subSize: 10,
  colors: {
    accent:  '#3fd0c9',   // активная сессия
    run:     '#e0a53f',   // работает
    ready:   '#4ade80',   // готова
    waiting: '#3fd0c9',   // ждёт ввода
    danger:  '#e05a5a',
  },
}
```

Цвета скопированы из `:root` (`styles.css:10-22`) — дефолт обязан совпасть с
текущей палитрой, это закреплено тестом.

- `normalizeTabStyle(raw)` — «never throws», как `normalizeAppearance`
  (`themes.js:117-130`). Неизвестная плотность откатывается к дефолту, размеры
  клампятся, невалидный hex заменяется дефолтным. На `null`, строке, мусоре —
  возвращает `DEFAULT_TABSTYLE`.
- `toCssVars(style)` — плоский объект `{'--tab-label-size': '12px', '--accent': '#3fd0c9', …}`.
- `bodyClasses(style)` — массив классов: `tabs-<density>` плюс `tab-no-dot`,
  `tab-no-ctx`, `tab-no-sub`, `tab-no-fill` для выключенных элементов.

Хранение — `localStorage['swarm.tabstyle']`, отдельно от `swarm.appearance`: та
описывает терминал, эта — хром.

### Применение

`applyTabStyle()` в `renderer.js` делает две вещи: ставит переменные из
`toCssVars` на `document.documentElement` через `setProperty` и синхронизирует
классы на `<body>` по `bodyClasses`. Перерисовки вкладок не требуется — весь
эффект каскадный.

`fit.fit()` вызывать не нужно. Высота хрома нигде в JS не считается, её задаёт
flexbox, а `ResizeObserver` на `#stage` (`renderer.js:1719-1723`) сам рефитит
терминал, когда бар изменил высоту. Это уже работает для сворачивания групп.

Загрузка при старте — `let tabstyle = loadTabStyle()` рядом с
`loadAppearance()` (`renderer.js:119-125`), применение — `applyTabStyle()` в
том же месте, где сейчас восстанавливается раскладка (`renderer.js:1996`).

## CSS

### Хардкод переезжает в переменные

Числа в `.tab` (`styles.css:172-234`) заменяются на `var(--tab-*)` с дефолтами в
`:root`:

`--tab-pad-y`, `--tab-pad-x`, `--tab-gap`, `--tab-min-w`, `--tab-max-w`,
`--tab-label-size`, `--tab-sub-size`, `--tab-dot-size`, `--ctx-h`.

Плотность задаёт их пачкой:

```css
body.tabs-compact { --tab-pad-y: 4px; --tab-pad-x: 8px; --tab-min-w: 90px; --tab-max-w: 150px; --tab-dot-size: 6px; --ctx-h: 3px; }
body.tabs-normal  { /* текущие значения */ }
body.tabs-roomy   { /* просторнее текущих */ }
```

Размеры шрифта пользователь задаёт сам, поэтому пресет плотности их **не
трогает** — иначе селект молча перетирал бы степперы.

### Компактный режим кладёт карточку в строку

```css
body.tabs-compact .tab { align-items: center; }
body.tabs-compact .tab .body { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; }
body.tabs-compact .tab .label { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
body.tabs-compact .tab .ctx { flex: 0 0 auto; margin-top: 0; }
body.tabs-compact .tab .sub { flex: 1 0 100%; }
```

При выключенной подписи компактная карточка становится одной строкой
`[● name ▓▓▓ 42%]` — около 28px против нынешних ~52px. При включённой подпись
переносится на вторую строку (`flex: 1 0 100%`).

Осознанный размен: в компактном режиме длинное имя обрезается многоточием
вместо переноса (`overflow-wrap: anywhere` в `styles.css:192`). Именно это и
даёт предсказуемую высоту; полное имя остаётся в `title` карточки.

### Видимость элементов

```css
body.tab-no-dot  .tab .dot { display: none; }
body.tab-no-ctx  .tab .ctx { display: none !important; }
body.tab-no-sub  .tab .sub { display: none; }
body.tab-no-fill .tab.status-ready,
body.tab-no-fill .tab.status-running,
body.tab-no-fill .tab.status-waiting,
body.tab-no-fill .tab.status-dead { background: var(--panel-2); border-color: var(--border); }
```

`!important` у `.ctx` обязателен: `updateCtx` (`renderer.js:309-319`) снимает
атрибут `hidden`, и правило `.tab .ctx[hidden] { display: none }` (`:200`) имеет
ту же специфичность, что наше.

Выключенная заливка гасит только фон и бордер статуса. Точка (если включена) и
акцентная рамка активной вкладки (`styles.css:233`) остаются — иначе активную
вкладку станет нечем отличить.

### Цвета

`applyTabStyle` переопределяет существующие `--accent`, `--ready`, `--run`,
`--waiting`, `--danger`. Каскад уже готов: точка, бордер, `color-mix`-заливка,
`.ctx-fill` по порогам, `.sum-dot` свёрнутой группы и активная рамка читают
именно эти переменные.

Осознанный размен: те же переменные красят статус-бар, кнопки и прогресс
обновления. Пользователь меняет цвета вкладок — меняется и они. Изоляцию под
`#tabs` не делаем: она потребовала бы дублировать пять переменных и разошлась
бы с палитрой приложения.

## Свёрнутая группа

Сейчас `.layout-top #tabs { align-items: stretch }` (`styles.css:104`)
растягивает свёрнутую группу по высоте самой высокой соседней. Правка:

```css
.layout-top .tab-group.collapsed { align-self: flex-start; }
```

Развёрнутые группы продолжают выравниваться по высоте друг с другом — текущий
вид сохраняется. `stretch` на контейнере не трогаем: он же выравнивает карточки
разной высоты внутри `.group-tabs` (`styles.css:119`).

Раскладка `layout-rail` не затронута — там группы идут колонкой и проблемы нет.

## Кнопка «новая сессия» в верхней раскладке

```css
.layout-top #new-session-folder .tx { display: none; }
.layout-top #new-session-folder { padding: 8px; }
.layout-top #chrome-actions { padding: 0 8px 0 4px; }
```

~140px → ~32px. Функциональность не теряется: тултип с `⌘O` уже есть
(`index.html:29`), хоткей работает, у каждой группы свой «+» (`.group-add`,
`renderer.js:1188-1192`).

В `layout-rail` кнопка остаётся с текстом — там она под списком, место есть, а
текст помогает.

## UI настроек

Шестая вкладка модалки: `<button class="set-tab" data-tab="tabs">Вкладки</button>`
рядом с «Вид» (`renderer.js:637-643`) и панель `.set-panel[data-panel="tabs"]`.

Отдельная вкладка, а не секция внутри «Вид»: та описывает терминал, и слияние
дало бы простыню из полутора десятков полей.

Содержимое панели:

- селект плотности (`.set-input`),
- четыре чекбокса видимости (`.set-check`),
- два степпера размеров (`.set-stepper`, как размер шрифта терминала),
- пять `<input type="color">` + кнопка «сбросить цвета» к дефолтам,
- живой предпросмотр `#set-tab-preview`.

Предпросмотр — статичная разметка карточки (`.dot`, `.label`, `.ctx`, `.sub`) с
фиктивными данными. Draft-переменные применяются к контейнеру `#set-tab-preview`
через `el.style.setProperty`, по образцу `renderTermPreview`
(`renderer.js:839-852`), а draft-классы из `bodyClasses` — через
`el.className`.

Чтобы правила не пришлось дублировать для `body` и для превью, все селекторы
плотности и видимости пишутся через `:where()` от общего предка:

```css
:where(body, #set-tab-preview).tabs-compact .tab { … }
:where(body, #set-tab-preview).tab-no-sub .tab .sub { display: none; }
```

`:where()` не добавляет специфичности, поэтому правило `.tab .ctx[hidden]`
по-прежнему перебивается только через `!important` — как описано выше.

Правки идут в `const draft = { ...tabstyle }` (`renderer.js:790`), Esc и Cancel
их выбрасывают. Save (`renderer.js:1016-1036`) пишет `tabstyle = { ...draft }`,
зовёт `saveTabStyle()` и `applyTabStyle()`.

## Тесты

`test/tabstyle.test.js` в стиле `test/themes.test.js`: плоский `node` + `assert`,
свой мини-раннер, `require('../renderer/tabstyle')`.

Покрытие:

- `normalizeTabStyle` возвращает дефолт на `null`, строке и мусоре;
- клампит `labelSize` и `subSize` по границам, включая строковый ввод;
- откатывает неизвестную плотность и невалидный hex;
- сохраняет валидный частичный объект, дополняя недостающее дефолтами;
- `toCssVars` возвращает ожидаемый набор ключей, значения с единицами (`px`);
- `bodyClasses` даёт `tabs-<density>` и корректный набор `tab-no-*`;
- регрессионный якорь: `DEFAULT_TABSTYLE.colors` совпадает с палитрой `:root`.

Плюс строка в цепочке `npm test` (`package.json:9`).

DOM-тестов нет — `renderer.js` не тестируется в этом репозитории вовсе. Отсюда и
правило: чистая логика живёт в UMD-модуле, в `renderer.js` остаётся проводка.

## Чего не делаем

- **Per-tab настроек.** Один глобальный набор.
- **Темы хрома целиком.** Двенадцать переменных `:root` остаются захардкоженными,
  светлой темы у хрома по-прежнему нет.
- **Цветов текста заголовка и подписи.** Семь пикеров вместо пяти — прямой путь к
  нечитаемой карточке.
- **Настройки позиции вкладок.** Тумблер `⌘L` между `layout-rail` и `layout-top`
  остаётся как есть.
- **Пресетов палитры.** Пять пикеров плюс «сбросить» покрывают задачу.

## Затрагиваемые файлы

| Файл | Правка |
|---|---|
| `renderer/tabstyle.js` | новый UMD-модуль |
| `renderer/index.html` | `<script>` до `renderer.js` |
| `renderer/renderer.js` | `loadTabStyle`/`saveTabStyle`/`applyTabStyle`, панель настроек, wiring, save |
| `renderer/styles.css` | переменные, пресеты плотности, классы видимости, фикс свёрнутой группы, кнопка в top |
| `test/tabstyle.test.js` | новый |
| `package.json` | строка в `npm test` |

IPC не добавляется, поэтому `test/preload-contract.test.js` не затрагивается.
