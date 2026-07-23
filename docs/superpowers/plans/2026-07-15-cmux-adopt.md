# Лучшее из cmux — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести из cmux внимание, причину ожидания, jump и (позже) hook-канал — не копируя Feed/браузер/мультиплексор.

**Architecture:** Pty-детектор остаётся источником `status`. Добавляем `waitingKind` + `question`, визуальный ring, ⌘⇧U, метаданные вкладок; затем opt-in Claude hooks/OSC как ускоритель и уточнитель. Ответ всегда в настоящий терминал.

**Tech Stack:** Electron, node-pty, xterm.js, `@xterm/headless`, плоские node-тесты.

**Spec:** `docs/superpowers/specs/2026-07-15-cmux-adopt-design.md`

**Зависимости (фаза 0 — не дублировать здесь):**

| План | Статус относительно этой программы |
|------|-------------------------------------|
| `docs/superpowers/plans/2026-07-15-pult.md` | **Сделать первым.** Даёт `question`, `waitingSince`, очередь. |
| `docs/superpowers/plans/2026-07-15-tab-diff.md` | Нужен до бейджа +/− (фаза B). Можно параллельно с A. |
| `docs/superpowers/plans/2026-07-15-tab-visual-settings.md` | Нужен до тумблеров сниппета (фаза B). Можно параллельно с A. |

---

## Как проверять работу

**НЕ запускать `npm start` и не убивать процессы**, пока у пользователя живые
агенты. На каждой задаче:

- `npm test` — автопроверка чистых модулей.
- UI — ⌘R в уже запущенном приложении + ручная проверка пользователем.

---

## Фазы (обзор)

```text
0  Пульт + (параллельно) tab-diff / visual-settings     ← существующие планы
A  Attention UX: kind, ring, ⌘⇧U, notify body           ← этот план
B  Метаданные вкладок: сниппет, branch, diff badge
C  Hooks + OSC + SWARM_SESSION_KEY routing
```

Фазы A→C делают строго по порядку. Внутри фазы — по Task N.

---

# Фаза A — Attention UX

Расширяет уже сделанный Пульт. Без hooks.

## File Structure (фаза A)

| Файл | Ответственность | Действие |
|------|-----------------|----------|
| `screen.js` | `extractQuestion` + эвристика `waitingKind` из снимка | Изменить (после пульта) |
| `test/screen.test.js` | kind на permission / question / idle снимках | Изменить |
| `main.js` | в `session:status` поля `question`, `waitingKind` | Изменить |
| `renderer/styles.css` | ring на waiting-холдере; оттенки kind | Изменить |
| `renderer/renderer.js` | kind в UI, ⌘⇧U, notify title/body/subtitle | Изменить |
| `renderer/keybinds.js` | зарегистрировать ⌘⇧U если бинды вынесены | Изменить при необходимости |
| `README.md` | кольцо, ⌘⇧U, kind | Изменить |

---

### Task A1: `waitingKind` из экрана

Эвристика рядом с `extractQuestion`. Hook-канал появится в C и будет
перебивать kind с более высоким приоритетом.

**Files:**
- Modify: `screen.js`
- Modify: `test/screen.test.js`
- Modify: `main.js`
- Modify: `package.json` (если тест ещё не в `npm test` — уже должен быть после пульта)

- [ ] **Step 1: Падающие тесты kind**

В `test/screen.test.js` добавить:

```js
test('permission chrome → permission', () => {
  assert.strictEqual(S.inferWaitingKind(PERMISSION), 'permission');
});

test('numbered question → question', () => {
  const snap = [
    'Какой цвет иконки?',
    '❯ 1. Синий',
    '  2. Серый',
    'model │ ~/p │ ██░ 40%',
  ].join('\n');
  assert.strictEqual(S.inferWaitingKind(snap), 'question');
});

test('«Сейчас от тебя» → question', () => {
  assert.strictEqual(S.inferWaitingKind('Сейчас от тебя: путь к схеме'), 'question');
});

test('empty quiet → idle', () => {
  assert.strictEqual(S.inferWaitingKind('>\n'), 'idle');
});
```

`PERMISSION` — тот же фикстурный блок, что в плане пульта.

- [ ] **Step 2: Реализация**

```js
// screen.js
function inferWaitingKind(snapshot) {
  const text = String(snapshot || '');
  if (/Esc to cancel|Do you want|No, and tell Claude|Enter to confirm/i.test(text)) {
    return 'permission';
  }
  if (/Сейчас от тебя/i.test(text)) return 'question';
  if (/[❯>→➜▸►▶]?\s*\d+\.\s/.test(text) && extractQuestion(text)) return 'question';
  if (extractQuestion(text)) return 'question';
  return 'idle';
}

module.exports = { extractQuestion, inferWaitingKind };
```

Уточнить regex под реальные фикстуры так, чтобы `PERMISSION` не классифицировался
как `question` из‑за `1. Yes` — permission-ветка должна идти первой (так и есть).

- [ ] **Step 3: main шлёт kind**

В тике детектора (после пульта там уже есть `question`):

```js
const question = next.status === 'waiting' ? extractQuestion(snapshot(d)) : null;
const waitingKind = next.status === 'waiting' ? inferWaitingKind(snapshot(d)) : null;
// … дифференциально в session:status вместе с question
```

- [ ] **Step 4: `npm test`**

- [ ] **Step 5: Commit**

```bash
git add screen.js test/screen.test.js main.js
git commit -m "$(cat <<'EOF'
feat(attention): waitingKind из снимка экрана

EOF
)"
```

---

### Task A2: Ring на waiting-холдере

**Files:**
- Modify: `renderer/styles.css`
- Modify: `renderer/renderer.js` (класс kind на holder/tab если ещё нет)

- [ ] **Step 1: CSS**

```css
.term-holder.active.status-waiting {
  box-shadow: inset 0 0 0 2px var(--waiting);
}
.term-holder.active.status-waiting.kind-permission {
  box-shadow: inset 0 0 0 2px var(--waiting); /* тот же токен; при желании отдельный --permission */
}
```

Класс `status-waiting` / `kind-*` ставит renderer при `setStatus` /
обновлении kind на `s.holder` (сейчас status вешается на tab — продублировать
на holder для ring).

- [ ] **Step 2: ⌘R, визуально проверить waiting-вкладку**

- [ ] **Step 3: Commit**

```bash
git add renderer/styles.css renderer/renderer.js
git commit -m "$(cat <<'EOF'
feat(attention): кольцо вокруг терминала в waiting

EOF
)"
```

---

### Task A3: ⌘⇧U → oldest waiting

**Files:**
- Modify: `renderer/renderer.js`
- Modify: `renderer/keybinds.js` (если шорткаты централизованы)

- [ ] **Step 1: Хелпер**

```js
function oldestWaitingId() {
  let best = null, bestSince = Infinity;
  for (const [id, s] of sessions) {
    if (s.status !== 'waiting' || s.waitingSince == null) continue;
    if (s.waitingSince < bestSince) { bestSince = s.waitingSince; best = id; }
  }
  return best;
}

function jumpToOldestWaiting() {
  const id = oldestWaitingId();
  if (!id) return;
  if (pultEnabled) {
    // открыть пульт на этом агенте (activate с { pult: true } + выбор чипа)
    activate(id, { pult: true });
    // убедиться что pultOn и выбранный чип = id
  } else {
    activate(id);
  }
}
```

Согласовать с API пульта из уже смёрженного кода (`pultOn`, `activate`).

- [ ] **Step 2: Бинд ⌘⇧U** рядом с ⌘0 / остальными аккордами; не конфликтовать с
  существующими (проверить `keybinds.js` / settings).

- [ ] **Step 3: Ручная проверка** — два waiting, ⌘⇧U → более старый.

- [ ] **Step 4: Commit**

```bash
git add renderer/renderer.js renderer/keybinds.js
git commit -m "$(cat <<'EOF'
feat(attention): ⌘⇧U прыгает к самому долгому waiting

EOF
)"
```

---

### Task A4: Notify с причиной

**Files:**
- Modify: `renderer/renderer.js` (`maybeNotify`)

- [ ] **Step 1: При переходе в waiting**

```js
// title = имя вкладки (s.tab label / displayName)
// subtitle = лейбл kind: разрешение | вопрос | ждёт
// body = (s.question || detail || '').slice(0, 140)
```

Click handler уведомления → `activate(id)` или тот же путь, что jump (если
Пульт включён и хотим консистентность —激活ровать через pult; иначе вкладка).
Спека: click ведёт в сессию; если `pultEnabled` — можно открыть Пульт на ней.

- [ ] **Step 2: ⌘R + перевод вкладки в фон + дождаться waiting**

- [ ] **Step 3: Commit**

```bash
git add renderer/renderer.js
git commit -m "$(cat <<'EOF'
feat(attention): в notify — имя вкладки, kind и текст вопроса

EOF
)"
```

---

### Task A5: Kind в рейле / чипе Пульта

**Files:**
- Modify: `renderer/renderer.js`
- Modify: `renderer/styles.css`

- [ ] **Step 1:** подпись статуса / чип: `разрешение` · `вопрос` · `ждёт` вместо
  единой «ждёт ответа», когда kind известен; fallback на старый текст.

- [ ] **Step 2: Commit**

```bash
git add renderer/renderer.js renderer/styles.css README.md
git commit -m "$(cat <<'EOF'
feat(attention): kind-лейблы на вкладках и в пульте

EOF
)"
```

---

# Фаза B — Метаданные вкладок

### Task B1: Сниппет вопроса на карточке вкладки

**Files:**
- Modify: `renderer/renderer.js`, `styles.css`, visual-settings (если смёржены)

- [ ] Показывать под именем (или вместо `.sub` при waiting) усечённый `s.question`.
- [ ] Тумблер `showQuestionSnippet` в visual settings, дефолт вкл.
- [ ] Commit: `feat(tabs): сниппет вопроса на waiting-вкладке`

### Task B2: Branch badge (опционально)

- [ ] Редкий refresh git branch для **видимых** вкладок (не все N сразу в
  свёрнутых группах), кэш на `s.gitBranch`.
- [ ] Тумблер, дефолт выкл.
- [ ] Если опрос дорог на Windows — отложить, не блокировать C.
- [ ] Commit: `feat(tabs): опциональный бейдж ветки на вкладке`

### Task B3: Diff badge +/−

- [ ] Зависит от `tab-diff`. Расширить лёгким `git diff --shortstat` / уже
  существующим API счётчика на неактивные вкладки по тому же редкому тику, что B2.
- [ ] Тумблер, дефолт выкл.
- [ ] Commit: `feat(tabs): опциональный +/− на вкладке`

---

# Фаза C — Hooks + OSC

### Task C1: Env `SWARM_SESSION_KEY` при spawn

**Files:** `main.js` (создание pty), возможно preload/renderer при передаче ключа.

- [ ] При старте/resume Claude-вкладки выставлять в env pty:
  `SWARM_SESSION_KEY=<swarm-…>` (тот же, что `-n` / `--resume`).
- [ ] Документировать в README.
- [ ] Тест: не ломает Windows spawn.
- [ ] Commit: `feat(hooks): SWARM_SESSION_KEY в env сессии`

### Task C2: Парсер OSC 777 / 9 в pty-чанке

**Files:** новый `osc.js` + `test/osc.test.js`, вызов из `feedDetector` / raw data handler.

- [ ] Вычленять `\x1b]777;notify;title;body\x07` и OSC 9; не ломать pen для xterm
  (данные всё равно пишутся в term — OSC обычно съедает эмулятор; для headless
  detector и UI-статуса парсить **сырой chunk до/параллельно write**).
- [ ] По событию: если удаётся связать с session — `waiting` + body как question;
  иначе игнор или active tab.
- [ ] `npm test`
- [ ] Commit: `feat(hooks): OSC notify → waiting + текст`

### Task C3: Скрипт `hooks/swarm-notify.sh` (или `.mjs`)

- [ ] Читает stdin JSON Claude hook, смотрит `hook_event_name`.
- [ ] `Notification` / permission-подобные → печатает OSC в tty **или** пишет
  JSON-линию в `$SWARM_HOOK_BUS` файл (выбрать одно в имплементации; спека
  рекомендует OSC-first).
- [ ] `Stop` → сигнал ready (OSC или bus).
- [ ] Не блокирует PermissionRequest: всегда быстрый exit, без decision JSON.
- [ ] Commit: `feat(hooks): скрипт Claude Notification/Stop`

### Task C4: Opt-in установка hooks в settings

**Files:** `renderer` settings UI + main helper merge JSON.

- [ ] Чекбокс «Claude hooks (точнее статус)» в настройках, дефолт выкл.
- [ ] Вкл: merge markered entries в `~/.claude/settings.json`.
- [ ] Выкл: удалить только наши markered hooks.
- [ ] Никогда не затирать чужие hooks.
- [ ] Commit: `feat(hooks): opt-in установка hooks Claude`

### Task C5: Main применяет hook-сигналы к нужной вкладке

- [ ] Маршрут: `SWARM_SESSION_KEY` / session id → tab id.
- [ ] Приоритет kind из hook > эвристика экрана.
- [ ] Антифлап: не бить `running`, пока идут байты (grace как у детектора).
- [ ] Commit: `feat(hooks): маршрутизация сигналов в вкладку`

### Task C6: README + ручной прогон

- [ ] Раздел: hooks, OSC, ⌘⇧U, kind, что не делаем (Feed).
- [ ] Пользователь: вкл hooks → permission → kind=permission без скрейпа;
  выкл hooks → fallback экран.

---

## Порядок коммитов (сводка)

1. Фаза 0: закрыть Пульт (отдельный план).
2. A1 → A5: kind, ring, jump, notify, лейблы.
3. B1 (сниппет); B2/B3 по возможности.
4. C1 → C6: session key, OSC, script, install, route.

## Явно не делать в этом плане

- Feed Allow/Deny / blocking `feed.permission.reply`
- Встроенный браузер, splits, SSH, socket API для внешних клиентов
- Hibernation агентов
- Поддержка Codex/OpenCode hooks (только Claude)
- Переписывание на native Ghostty

## Критерий готовности программы

- [ ] Пульт работает с `question` в чипах.
- [ ] Waiting-холдер с кольцом; ⌘⇧U ведёт к oldest waiting.
- [ ] Notify показывает вкладку + kind + вопрос.
- [ ] Сниппет вопроса на вкладке (B1).
- [ ] Opt-in hooks улучшают kind/latency; без hooks поведение = фазы A/B.
