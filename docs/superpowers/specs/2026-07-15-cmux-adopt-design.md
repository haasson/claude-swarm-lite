# Лучшее из cmux — design

Дата: 2026-07-15

## Цель

Перенять у [cmux](https://github.com/manaflow-ai/cmux) то, что делает охоту за
агентами быстрой и надёжной — сигналы «кто зовёт», причину, моментальный jump —
не превращая Claude Swarm Lite в терминал-мультиплексор.

Мы остаёмся **opinionated пультом для Claude Code** (Electron + pty + xterm).
cmux для нас — каталог идей про attention и метаданные, не целевая архитектура.

## Принцип

1. **Агент говорит сам, экран — fallback.** Hooks и OSC усиливают статус; парсер
   экрана (`decide` / `extractQuestion`) не удаляем.
2. **Ответ всегда в настоящий терминал.** Никаких Allow/Deny-кнопок поверх Claude
   (их Feed). Терминал уже показывает вопрос — мы только подводим к нему.
3. **Один статус + kind, не пять lifecycle.** `running` / `ready` / `waiting` /
   `dead` уже есть. Для waiting добавляем `waitingKind`, не новый мир стейтов.
4. **Сначала дожать текущие спеки, потом hooks.** Пульт, дифф, визуал вкладок —
   фундамент; иначе metadata и jump некуда вешать.

## Что берём

| Идея cmux | Как у нас | Фаза |
|---|---|---|
| Notification rings | Рамка/свечение холдера в `waiting` | A |
| Текст «почему зовут» | `question` + `waitingKind` в чипе, рейле, системном notify | A |
| Jump to latest/oldest unread | ⌘⇧U → самый долгий `waiting` (или Пульт, если включён) | A |
| Notification panel ≈ очередь | уже: **Пульт** (спека `2026-07-15-pult`) | 0 |
| Sidebar metadata | сниппет вопроса, ветка, +/− диффа на вкладке | B |
| Hooks → needsInput | Claude hooks → точный статус + kind | C |
| Session ↔ surface binding | уже есть `swarm-*` + `--resume`; жёстче документируем и чиним дыры | C |
| OSC 9/99/777 | опциональный канал notify/status, если нет hooks | C |
| Классификация permission vs question | `waitingKind: 'permission' \| 'question' \| 'idle'` | A+C |

## Что сознательно не берём

| cmux | Почему нет |
|---|---|
| Swift / libghostty | другой продукт; Windows пропадёт |
| Feed Allow/Deny / blocking hook reply | дублирует TUI Claude; ломает наш принцип «настоящий терминал» |
| In-app browser + agent-browser | огромный скоуп вне пульта |
| CLI + Unix socket API | нет аудитории автоматизации |
| Workspaces / splits / SSH / remote tmux | мы — вкладки, не мультиплексор |
| Claude Teams → native panes | позже, если вообще; не в этой программе |
| Agent hibernation (kill + resume) | риск для lite, сомнительный выигрыш |
| iOS companion | вне продукта |
| Multi-agent matrix (Codex, OpenCode…) | фокус Claude Code + текущий cmd/flags |

## Модель внимания

### Статусы (без ломающих изменений)

| `status` | Смысл |
|---|---|
| `running` | работает |
| `ready` | готов / idle |
| `waiting` | зовёт человека |
| `dead` | процесс мёртв |

### Новый `waitingKind` (только при `waiting`)

| Kind | Откуда | UI |
|---|---|---|
| `permission` | chrome разрешения / hook PermissionRequest | жёлтая/янтарная акцентность, подпись «разрешение» |
| `question` | AskUserQuestion / варианты / «Сейчас от тебя» / extractQuestion | как сейчас waiting, подпись «вопрос» |
| `idle` | generic Notification без permission chrome; нет вопроса | мягкий waiting, «ждёт» |
| `null` | детекту ещё нечего сказать | как сейчас, без под-лейбла |

Источники kind (приоритет сверху вниз):

1. Hook payload (фаза C) — самый надёжный.
2. Эвристика экрана: `RE_WAIT_NOW` / permission-рамка → `permission`;
   варианты / `RE_WAIT_ASK` / ненулевой `question` → `question`; иначе `idle`.
3. Иначе `null`.

Pty-детектор остаётся источником истины для `status`. Hook может только:

- ускорить переход в `waiting` / `ready` / `running`;
- уточнить `waitingKind` и текст;
- **не** спорить с живым `running` дольше grace (антифлап как у `RUN_BUFFER_MS`).

### Jump ⌘⇧U

- Есть хотя бы один `waiting` → активировать того с минимальным `waitingSince`
  (дольше всех ждёт). Если Пульт включён — открыть Пульт на нём.
- Нет waiting → no-op (или краткий flash «никто не ждёт» — опционально, YAGNI
  до запроса).
- Не путать с ⌘0 (вход в Пульт как режим): ⌘⇧U — действие «доставь меня к
  человеку, который ждёт», даже если Пульт выключен.

### Кольцо (ring)

- На `#stage .term-holder.active` при `status === 'waiting'` — заметная рамка
  (2–3px, цвет `--waiting` или по `waitingKind`).
- На вкладке — уже есть заливка статуса; усиливаем только при желании через
  существующие visual settings, новый тумблер не обязателен.
- Кольцо гаснет при уходе из `waiting` (с учётом текущего 2.5s буфера running).

### Системные уведомления

Сейчас часто тело без контекста. Ближе к cmux / к issue, который они сами
признают:

- title = имя вкладки (не «Claude Swarm»);
- subtitle = kind-лейбл (`разрешение` / `вопрос` / `ждёт`);
- body = `question` или `detail`, обрезать ~140 символов;
- click → тот же путь, что ⌘⇧U на эту сессию (вкладка или Пульт).

Поведение mute / notifyOnWaiting / notifyOnReady не меняем.

## Метаданные вкладки (фаза B)

На карточке вкладки (рейл и/или дашборд), сверх имени и точки статуса:

| Бейдж | Источник | Показ |
|---|---|---|
| сниппет вопроса | `s.question` | только в `waiting`, одна строка, truncate |
| ветка | лёгкий опрос git cwd вкладки **или** кэш от последнего refresh | опционально в visual settings |
| `+N −M` | из будущей спеки tab-diff, но **per-tab** лёгкий счётчик | опционально |

Осознанный размен относительно tab-diff-design («считаем только активную»):
для бейджей нужен редкий опрос N папок (например раз в 10–15 с и только
развёрнутые группы). Если дорого — сначала только `question` сниппет (он уже
едет в `session:status`), ветку/дифф — вторым шагом.

Новые тумблеры в visual settings: `showQuestionSnippet`, `showBranchBadge`,
`showDiffBadge` — дефолт: сниппет вкл, branch/diff выкл (пока не измеряли
стоимость).

## Hooks (фаза C)

### Установка

Настройка «Интеграция Claude hooks» (выкл по умолчанию, opt-in):

- при включении пишем/мержим в `~/.claude/settings.json` (или project
  settings — уточнить при имплементации: безопаснее user-level с маркером
  `swarm-lite`) команды:

  - `Notification` → `swarm-hook notify` (или node-скрипт рядом с приложением)
  - `Stop` → idle/ready
  - `UserPromptSubmit` / старт хода → running
  - опционально `PermissionRequest` → waiting + kind=permission **без**
    блокирующего JSON-ответа: хук сразу `exit 0` / `{}`, решение остаётся в TUI

- при выключении снимаем только наши маркеры, чужие hooks не трогаем.

### Доставка в app

Хук не может говорить в Electron напрямую. Варианты (выбрать при имплементации):

1. **Unix socket / named pipe** рядом с app (как cmux sock) — идеально, но код.
2. **Файл-сигнал** в `os.tmpdir()` / app userData, main поллит раз в 300 мс —
   проще, достаточно для lite.
3. **OSC в pty** — хук печатает OSC 777; main уже кормит detector —
   перехват OSC в `feedDetector` / отдельный парсер чанка.

Рекомендация плана: начать с **OSC 777 + парсер в main** (ноль IPC-файлов,
работает и без «установки hooks», если пользователь/агент шлёт OSC сам), плюс
тонкий скрипт hooks, который зовёт `printf` OSC или пишет sidecar-файл с
`sessionKey` для маршрутизации, когда вкладка не сфокусирована.

Маршрутизация: Claude session id / наше `swarm-*` имя → tab id. Без привязки
хук падает в active tab или игнорируется (логируем).

### Совместимость с resume

`sessionKey` (`swarm-*`) уже пинится через `-n`. Hooks и OSC должны нести тот
же ключ (из env, который main выставляет при spawn: `SWARM_SESSION_KEY=…`),
чтобы фон не промахивался по вкладке.

## Зависимости от существующих спек

| Спека | Роль |
|---|---|
| `2026-07-15-pult` | очередь, `question`, `waitingSince`, ⌘0 — **фаза 0, делать первой** |
| `2026-07-15-tab-diff` | источник +/−; фаза B может расширить до per-tab badge |
| `2026-07-15-tab-visual-settings` | тумблеры сниппета/бейджей, цвета kind |
| Resume 0.6.22 | база для `SWARM_SESSION_KEY` и привязки hooks |

## Успех

После программы пользователь с 6–8 Claude-вкладками:

1. Видит **кольцо** на том, кто ждёт, не открывая рейл.
2. По ⌘⇧U попадает к самому долгому waiting за один аккорд.
3. В чипе Пульта и в notify читает **о чём** спросили, не только «ждёт».
4. (Фаза C) Permission vs вопрос различимы даже когда TUI Claude меняет глифы —
   пока hooks живы; без hooks экранный fallback как сегодня.

## Вне охвата всей программы

Feed UI, браузер, splits, SSH, CLI API, Codex/OpenCode, hibernation, нативный
рерайт, Windows-специфичные отличия хуков сверх named pipe / OSC.
