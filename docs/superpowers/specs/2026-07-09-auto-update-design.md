# Авто-обновление — дизайн

**Дата:** 2026-07-09
**Статус:** утверждён к реализации

## Задача

Дать пользователю обновлять приложение **по кнопке из самого приложения**, не
скачивая каждый раз весь ~95 МБ установщик. Аудитория — коллеги («свои») с
доступом к репозиторию, готовые к предупреждениям о неподписанном приложении.
Платить за Apple Developer не будем → тихий системный авто-апдейт (Squirrel.Mac)
недоступен. Значит делаем свой механизм.

## Ключевая идея

Весь наш код лежит в `app.asar` (~4.5 МБ). Остальные ~90 МБ сборки — это Electron
и распакованный бинарник node-pty, которые меняются редко. Поэтому обновление =
скачать и подменить **только `app.asar`**. `app.asar` **платформо-независим**
(JS + xterm; node-pty вынесен из asar через `asarUnpack`) → **один `app.asar`
подходит и macOS, и Windows**, публикуем один файл.

Полный установщик (dmg/exe) нужен только когда меняется рантайм (версия Electron
или нативных зависимостей) — это отслеживается через `runtimeId` (см. ниже).

## Решения брейншторма

- **Оповещение:** плашка в нижнем баре «↑ Обновить X.Y.Z» (не навязчиво, всегда
  на виду при наличии апдейта).
- **Когда проверять:** при старте (с задержкой) + периодически в фоне (~4 ч) +
  вручную из настроек.
- **Доступ к приватному реестру:** вшитый **read-only** токен реестра,
  инжектится при сборке из env (не коммитится в git).
- **Windows:** тот же asar-swap; NSIS ставит per-user (`perMachine:false`) →
  папка юзера, права на запись есть, self-relocation не нужен.
- **macOS:** asar-swap + self-relocation в `~/Applications` (чтобы гарантировать
  права на подмену `app.asar`).

## Архитектура

### 1. Манифест обновления

JSON по стабильному URL в реестре: `apps/latest/manifest.json` (перезаписывается
каждым релизом). Схема:

```json
{
  "version": "0.4.0",
  "runtimeId": "<sha256(electronVersion + nodePtyVersion)>",
  "asar": { "url": "<base>/apps/0.4.0/app.asar", "sha256": "<hex>" },
  "installers": {
    "dmg": "<base>/apps/0.4.0/claude-swarm-lite-0.4.0-arm64.dmg",
    "exe": "<base>/apps/0.4.0/claude-swarm-lite-0.4.0-x64.exe"
  },
  "notes": "<строки из CHANGELOG для этой версии>",
  "pubDate": "2026-07-09T12:00:00Z"
}
```

`<base>` = `https://gitlab.internal/api/v4/projects/331/packages/generic`.

### 2. `runtimeId` — совместимость рантайма

`runtimeId = sha256(electronVersion + '|' + nodePtyVersion)`, где версии берутся
из установленных `node_modules/electron/package.json` и
`node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json` во время
сборки. Пишется в **два места**: в `build-info.json` внутри собираемого asar (это
`runtimeId` конкретной сборки) и в манифест релиза.

Аппа сравнивает свой `runtimeId` (из бандла) с `runtimeId` из свежего манифеста:
- совпал → `app.asar` совместим → **asar-swap**;
- не совпал → рантайм изменился → **только полный установщик**.

### 3. `build-info.json` (генерируемый, gitignore, внутри asar)

```json
{ "runtimeId": "<sha256>", "updateToken": "<read-only registry token>" }
```

Генерится `release.mjs` **до** сборки (чтобы asar его вобрал). `updateToken`
берётся из env `UPDATE_REGISTRY_TOKEN`. Файл в `.gitignore` — в git не попадает,
только в собранный asar. Версия приложения отдельно не дублируется — берётся из
`app.getVersion()`.

### 4. Ядро — `updater.js` (main-процесс)

Чистые, тестируемые функции (dual-mode, как `themes.js`/`logstore.js`):
- `compareVersions(a, b)` → -1|0|1 (semver-строки `x.y.z`).
- `decideUpdate(installedVersion, installedRuntimeId, manifest)` →
  `{ kind: 'none'|'asar'|'installer', version, notes }`.
  - `none` — манифест не новее.
  - `asar` — новее и `runtimeId` совпал.
  - `installer` — новее, но `runtimeId` разошёлся.
- `validateManifest(obj)` → нормализованный манифест или бросает (битый JSON/поля).

Функции с побочными эффектами (в `updater.js`, не в чистом модуле):
- `readBuildInfo()` → `{ runtimeId, updateToken }` из бандла (или дефолты в dev).
- `fetchManifest()` → GET манифеста с заголовком `PRIVATE-TOKEN: <updateToken>`.
- `checkForUpdate()` → `fetchManifest` + `decideUpdate` → результат.
- `downloadAsar(url, sha256, onProgress)` → качает во временный файл, сверяет
  sha256; при несовпадении — бросает и удаляет временный файл.
- `applyAsar(tmpPath)` → `app.asar` → `app.asar.bak`, затем temp → `app.asar`.
  Перед этим проверяет запись в `path.dirname(resourcesAsarPath)`; при отказе —
  бросает (renderer покажет фолбэк на установщик).
- `resourcesAsarPath()` → `path.join(process.resourcesPath, 'app.asar')`.

Откат: `app.asar.bak` остаётся после апдейта. Основная защита целостности — сверка
sha256 до подмены. Ручное восстановление: вернуть `.bak`. (Авто-watchdog отката —
вне охвата v1.)

### 5. Self-relocation (только macOS, при старте, `updater.js`)

`maybeRelocate()` вызывается в `app.whenReady()` **до** `createWindow()`:
- только если `app.isPackaged` и `process.platform === 'darwin'`;
- условие переезда: путь бандла начинается с `/Volumes/` (запущено из dmg) **или**
  `process.resourcesPath` недоступен на запись;
- если уже отказывались (флаг в `app.getPath('userData')/relocate-declined`) —
  пропуск;
- диалог `dialog.showMessageBox` «Переместить в Applications?»: при согласии —
  копирует `.app` в `~/Applications` (`fs.cpSync`), снимает quarantine
  (`xattr -dr com.apple.quarantine <dest>`), запускает новый бандл через `open`,
  затем `app.exit(0)`; при отказе — пишет флаг и продолжает как обычно.

### 6. Токен доступа

Вшитый read-only токен реестра (в `build-info.json`, инжектится при сборке). Все
запросы апдейтера идут с `PRIVATE-TOKEN: <updateToken>`. Токен только читает
пакеты, к которым у аудитории и так есть доступ — риск утечки нулевой сверх
имеющегося. В dev (`build-info.json` нет) апдейтер тихо выключен.

### 7. UI (renderer)

- **Плашка `#update-pill`** в нижнем баре (`index.html`, рядом с `#log-indicator`):
  скрыта; при доступном апдейте показывает «↑ Обновить X.Y.Z». Клик → модалка.
- **Модалка апдейта** (строится в JS, как остальные):
  - текущая → новая версия, заметки;
  - `asar`: кнопка «Обновить и перезапустить» → прогресс-бар скачивания →
    по завершении relaunch;
  - `installer`: текст «Нужен полный установщик (изменился рантайм)» + кнопка
    «Скачать установщик» → аппа сама качает dmg/exe **с токеном** в `~/Downloads`
    (URL реестра приватный, в браузере дал бы 401) и по завершении открывает папку
    (`showItemInFolder`). Без relaunch — дальше пользователь ставит вручную.
  - «Позже» — закрывает, запоминает `snoozeVersion`.
- **Логика проверки:** через ~3 c после старта + `setInterval` ~4 ч + кнопка
  «Проверить обновления» в новой вкладке Настроек **«Обновления»** (там же текущая
  версия `app.getVersion()` и результат последней проверки).
  `localStorage`: `swarm.update.lastCheck` (троттлинг фоновой проверки),
  `swarm.update.snooze` (версия, которую отложили — не показывать плашку для неё
  до перезапуска).

### 8. IPC / preload

Новые методы `window.swarm`:
- `updateCheck()` → invoke `update:check` → результат `decideUpdate`.
- `updateApply(url, sha256)` → invoke `update:apply` (download+verify+swap) →
  `{ ok }` или `{ ok:false, error }`.
- `updateRelaunch()` → send `update:relaunch` (`app.relaunch(); app.exit(0)`).
- `updateDownloadInstaller(url, filename)` → invoke `update:installer` — качает
  установщик **с токеном** в `~/Downloads`, затем `showItemInFolder` → `{ ok, path }`.
- `onUpdateProgress(cb)` → подписка на `update:progress` (проценты скачивания).
- `getVersion()` → invoke `app:version` (`app.getVersion()`).

Контракт-тест `preload-contract` покрывает их автоматически.

### 9. Публикация — изменения в `release.mjs`

Порядок в скрипте:
1. (существующее) bump версии, CHANGELOG, README, commit+tag.
2. **новое:** вычислить `runtimeId`; записать `build-info.json`
   (`{runtimeId, updateToken: process.env.UPDATE_REGISTRY_TOKEN}`).
3. (существующее) `npm run dist` — asar вбирает `build-info.json`.
4. **новое:** достать `dist/mac-arm64/Claude Swarm Lite.app/Contents/Resources/app.asar`,
   посчитать sha256; залить в `apps/<version>/app.asar`.
5. (существующее) залить dmg.
6. **новое:** собрать `manifest.json` (version, runtimeId, asar url+sha256,
   installers dmg/exe, notes из CHANGELOG-секции, pubDate) и залить в
   `apps/latest/manifest.json` (перезапись).
7. (существующее) push main + tag.

`UPDATE_REGISTRY_TOKEN` задаётся в env рядом с `GITLAB_TOKEN` (в `~/.zshrc`). Если
не задан — `build-info.json` пишется без токена, апдейтер в этой сборке выключен
(релиз не падает, но self-update работать не будет — предупредить в выводе).

### 10. CI

Изменений в `.gitlab-ci.yml` не требуется: `app.asar` и манифест публикует
локальный `release.mjs`. Windows-`.exe` из CI остаётся установщиком-фолбэком.
(`build-info.json` в gitignore; на Windows-сборке его нет — но CI собирает только
установщик, которому апдейтер не нужен.)

## Тестирование

Проект гоняет node-тесты без фреймворка (`npm test`). Добавляем `test/updater.test.js`
для чистого модуля:
- `compareVersions` — упорядочивание, равенство, разная длина.
- `decideUpdate` — none (не новее / равна), asar (новее + runtimeId совпал),
  installer (новее + runtimeId разошёлся).
- `validateManifest` — валидный проходит; битый (нет version/asar.sha256) бросает.

Плюс существующий `preload-contract` ловит рассинхрон новых `window.swarm.*`.

Пред-релизная проверка вживую невозможна из этой сессии (нельзя перезапускать
рабочий инстанс) — верифицируем юнит-тестами, `node --check`, и симуляцией загрузки
рендерера (vm-шим с реальным preload). Живьём проверяет пользователь после установки.

## Обработка краёв

- Нет прав на запись `app.asar` → `applyAsar` бросает → модалка показывает фолбэк
  «Скачать установщик».
- sha256 не совпал → asar не подменяется, временный файл удаляется, ошибка в логи-«!».
- Токен невалиден / нет сети → `checkForUpdate` тихо возвращает «нет апдейта» +
  запись в логи-«!»; плашка не появляется.
- `runtimeId` разошёлся → только установщик (никогда не подменяем asar между
  несовместимыми рантаймами).
- dev-режим (`!app.isPackaged` или нет `build-info.json`) → апдейтер и
  self-relocation полностью выключены.
- quarantine на скачанном asar не возникает (пишем сырые байты через `fs`, не через
  загрузчик с флагом карантина). Для self-relocation копируемого `.app` — снимаем.
- Двойной клик по плашке во время скачивания → модалка одна (гвард как у других).

## Вне охвата (YAGNI)

- Тихий фоновый авто-апдейт без клика (нужна подпись; отказались).
- Дельта внутри asar (asar и так ~4.5 МБ — качаем целиком).
- Авто-watchdog отката при битой сборке (ручной откат через `.bak`).
- Множественные каналы (stable/beta), откат на предыдущую версию из UI.
- Линукс (сборок нет).
