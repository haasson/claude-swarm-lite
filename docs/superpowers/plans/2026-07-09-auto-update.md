# Авто-обновление — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обновление приложения по кнопке из аппы через подмену только `app.asar` (~4.5 МБ), с self-relocation в `~/Applications` на маке и фолбэком на полный установщик при смене рантайма; плашка «↑ Обновить» в нижнем баре.

**Architecture:** Чистая логика решения (`updater-core.js`, юнит-тесты) отделена от эффектов (`updater.js`: сеть/fs/electron). `main.js` даёт IPC, `preload.js` — мост, `renderer.js` — плашку/модалку. `release.mjs` публикует `app.asar` + `manifest.json` в GitLab-реестр. Доступ — вшитый read-only токен в gitignore-`build-info.json` (инжектится при сборке).

**Tech Stack:** Electron 29, Node (https/fs/crypto), ванильный JS/CSS, node-тесты без фреймворка.

**ВАЖНО:** приложение у пользователя запущено с живыми агентами — **не запускать `npm start`/не убивать процесс**. Верификация: `npm test`, `node --check`, vm-симуляция загрузки рендерера. Живьём проверяет пользователь после установки.

---

## Структура файлов

- **Создать `updater-core.js`** (корень репо, обычный CommonJS как `git.js`) — чистые `compareVersions`, `computeRuntimeId`, `validateManifest`, `decideUpdate`. Только эта единица юнит-тестируется.
- **Создать `test/updater.test.js`** — тесты чистой логики.
- **Создать `updater.js`** (корень) — эффекты: `readBuildInfo`, `checkForUpdate`, `applyAsar`, `downloadInstaller`, `maybeRelocate`.
- **Изменить `main.js`** — IPC-обработчики апдейтера + `maybeRelocate` в `whenReady`.
- **Изменить `preload.js`** — методы `window.swarm` для апдейта.
- **Изменить `renderer/renderer.js`** — плашка, модалка, проверка при старте/периодически, вкладка «Обновления».
- **Изменить `renderer/index.html`** — кнопка `#update-pill`.
- **Изменить `renderer/styles.css`** — стили плашки/модалки.
- **Изменить `scripts/release.mjs`** — runtimeId, build-info.json, публикация asar + manifest.
- **Изменить `package.json`** — `build.files` (+updater*.js, build-info.json), `test`-скрипт.
- **Изменить `.gitignore`** — `build-info.json`.

---

## Task 1: Чистая логика апдейтера (`updater-core.js`)

**Files:**
- Create: `updater-core.js`
- Test: `test/updater.test.js`
- Modify: `package.json` (test-скрипт)

- [ ] **Step 1: Написать падающий тест**

Create `test/updater.test.js`:

```js
// Pure-logic tests for the updater (no fs/net). Run: node test/updater.test.js
const assert = require('assert');
const core = require('../updater-core');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const RID = core.computeRuntimeId('29.4.6', '0.13.1'); // a stable id for tests

function manifest(over) {
  return Object.assign({
    version: '0.4.0',
    runtimeId: RID,
    asar: { url: 'https://x/app.asar', sha256: 'ABCD' },
    installers: { dmg: 'https://x/a.dmg', exe: 'https://x/a.exe' },
    notes: 'note', pubDate: '2026-07-09',
  }, over || {});
}

test('compareVersions orders semver', () => {
  assert.strictEqual(core.compareVersions('0.4.0', '0.3.9'), 1);
  assert.strictEqual(core.compareVersions('0.3.0', '0.3.1'), -1);
  assert.strictEqual(core.compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(core.compareVersions('0.10.0', '0.9.0'), 1); // numeric, not lexical
});

test('computeRuntimeId is deterministic and input-sensitive', () => {
  assert.strictEqual(core.computeRuntimeId('29.4.6', '0.13.1'), core.computeRuntimeId('29.4.6', '0.13.1'));
  assert.notStrictEqual(core.computeRuntimeId('29.4.6', '0.13.1'), core.computeRuntimeId('30.0.0', '0.13.1'));
});

test('validateManifest normalizes and lowercases sha', () => {
  const m = core.validateManifest(manifest());
  assert.strictEqual(m.asar.sha256, 'abcd');
  assert.strictEqual(m.version, '0.4.0');
});

test('validateManifest throws on bad input', () => {
  assert.throws(() => core.validateManifest(null));
  assert.throws(() => core.validateManifest(manifest({ version: 'x' })));
  assert.throws(() => core.validateManifest(manifest({ asar: { url: 'u' } }))); // no sha256
});

test('decideUpdate: none when not newer', () => {
  assert.strictEqual(core.decideUpdate('0.4.0', RID, manifest()).kind, 'none');
  assert.strictEqual(core.decideUpdate('0.5.0', RID, manifest()).kind, 'none');
});

test('decideUpdate: asar when newer and runtimeId matches', () => {
  const d = core.decideUpdate('0.3.0', RID, manifest());
  assert.strictEqual(d.kind, 'asar');
  assert.strictEqual(d.version, '0.4.0');
  assert.strictEqual(d.asar.sha256, 'abcd');
});

test('decideUpdate: installer when newer but runtimeId differs', () => {
  const d = core.decideUpdate('0.3.0', 'DIFFERENT', manifest());
  assert.strictEqual(d.kind, 'installer');
  assert.ok(d.installers.dmg);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `node test/updater.test.js`
Expected: FAIL — `Cannot find module '../updater-core'`.

- [ ] **Step 3: Создать `updater-core.js`**

Create `updater-core.js`:

```js
// updater-core.js — pure update logic (no fs/net/electron), unit-tested.
'use strict';
const crypto = require('crypto');

// Compare two "x.y.z" versions → -1 | 0 | 1 (numeric per-segment).
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Runtime fingerprint: if this changes between releases, app.asar is NOT swap-safe
// (Electron or a native dep moved) and a full installer is required.
function computeRuntimeId(electronVersion, nodePtyVersion) {
  return crypto.createHash('sha256').update(`${electronVersion}|${nodePtyVersion}`).digest('hex');
}

function validateManifest(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('manifest is not an object');
  if (typeof obj.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(obj.version)) throw new Error('bad version');
  if (typeof obj.runtimeId !== 'string' || !obj.runtimeId) throw new Error('missing runtimeId');
  if (!obj.asar || typeof obj.asar.url !== 'string' || typeof obj.asar.sha256 !== 'string') {
    throw new Error('missing asar url/sha256');
  }
  return {
    version: obj.version,
    runtimeId: obj.runtimeId,
    asar: { url: obj.asar.url, sha256: obj.asar.sha256.toLowerCase() },
    installers: (obj.installers && typeof obj.installers === 'object') ? obj.installers : {},
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    pubDate: typeof obj.pubDate === 'string' ? obj.pubDate : '',
  };
}

// Decide what an installed (version, runtimeId) should do given a fetched manifest.
function decideUpdate(installedVersion, installedRuntimeId, manifest) {
  const m = validateManifest(manifest);
  if (compareVersions(m.version, installedVersion) <= 0) {
    return { kind: 'none', version: m.version, notes: m.notes };
  }
  const kind = m.runtimeId === installedRuntimeId ? 'asar' : 'installer';
  return { kind, version: m.version, notes: m.notes, asar: m.asar, installers: m.installers };
}

module.exports = { compareVersions, computeRuntimeId, validateManifest, decideUpdate };
```

- [ ] **Step 4: Прогнать — проходит**

Run: `node test/updater.test.js`
Expected: PASS — `7/7 passed`.

- [ ] **Step 5: Добавить в `npm test`**

Modify `package.json`, строка `test`:

```json
    "test": "node test/themes.test.js && node test/preload-contract.test.js && node test/logstore.test.js && node test/updater.test.js",
```

Run: `npm test`
Expected: все сюиты зелёные, exit 0.

- [ ] **Step 6: Commit**

```bash
git add updater-core.js test/updater.test.js package.json
git commit -m "feat(апдейт): чистая логика решения об обновлении + тесты"
```

---

## Task 2: Эффекты апдейтера (`updater.js`)

**Files:**
- Create: `updater.js`

Верификация — `node --check` + чтение (сеть/fs/electron не юнит-тестируются). **Приложение не запускать.**

- [ ] **Step 1: Создать `updater.js`**

Create `updater.js`:

```js
// updater.js — main-process update mechanics (fs / net / electron). Pure decisions
// live in updater-core. Fully disabled in dev (not packaged, or no build-info.json).
const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const core = require('./updater-core');

const MANIFEST_URL =
  'https://gitlab.internal/api/v4/projects/331/packages/generic/apps/latest/manifest.json';

// build-info.json is bundled at the app root (inside app.asar); holds this build's
// runtimeId + the read-only registry token. Absent in dev → updater is off.
function readBuildInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8')); }
  catch (_) { return null; }
}
function enabled() { return app.isPackaged && !!readBuildInfo(); }

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: token ? { 'PRIVATE-TOKEN': token } : {} }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// Download url → destPath with optional sha256 verify + progress(percent). Deletes
// the partial file on sha mismatch.
function download(url, token, destPath, expectedSha, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: token ? { 'PRIVATE-TOKEN': token } : {} }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(destPath);
      out.on('error', reject);
      res.on('error', reject);
      res.on('data', (c) => {
        got += c.length; hash.update(c);
        if (onProgress && total) onProgress(Math.round((got / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        const sha = hash.digest('hex');
        if (expectedSha && sha !== String(expectedSha).toLowerCase()) {
          fs.unlink(destPath, () => {});
          reject(new Error('sha256 mismatch'));
          return;
        }
        resolve(destPath);
      }));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
  });
}

async function checkForUpdate() {
  if (!enabled()) return { kind: 'none' };
  const info = readBuildInfo();
  const buf = await httpGet(MANIFEST_URL, info.updateToken);
  const manifest = JSON.parse(buf.toString('utf8'));
  return core.decideUpdate(app.getVersion(), info.runtimeId, manifest);
}

function resourcesAsarPath() { return path.join(process.resourcesPath, 'app.asar'); }

// Download the new asar (verified), then swap it in with a .bak backup. Throws if
// the app dir isn't writable or the hash mismatches → renderer offers the installer.
async function applyAsar(asarUrl, sha256, onProgress) {
  if (!enabled()) throw new Error('updater disabled');
  const info = readBuildInfo();
  const asarPath = resourcesAsarPath();
  const dir = path.dirname(asarPath);
  fs.accessSync(dir, fs.constants.W_OK); // throws if not writable
  const tmp = path.join(dir, 'app.asar.download');
  await download(asarUrl, info.updateToken, tmp, sha256, onProgress);
  const bak = path.join(dir, 'app.asar.bak');
  try { fs.rmSync(bak, { force: true }); } catch (_) {}
  fs.renameSync(asarPath, bak);   // keep old for manual rollback
  fs.renameSync(tmp, asarPath);
  return { ok: true };
}

async function downloadInstaller(url, filename) {
  if (!enabled()) throw new Error('updater disabled');
  const info = readBuildInfo();
  const dest = path.join(app.getPath('downloads'), filename);
  await download(url, info.updateToken, dest, null, null);
  shell.showItemInFolder(dest);
  return { ok: true, path: dest };
}

// --- self-relocation (macOS): ensure the app lives somewhere user-writable so a
// later asar-swap works. Returns true if it kicked off relocation (caller must NOT
// open a window — we exit after copying).
function isWritable(p) { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch (_) { return false; } }

function maybeRelocate() {
  if (!app.isPackaged || process.platform !== 'darwin') return false;
  const bundle = app.getPath('exe').split('/Contents/')[0]; // .../Claude Swarm Lite.app
  const fromDmg = bundle.startsWith('/Volumes/');
  if (!fromDmg && isWritable(process.resourcesPath)) return false; // already fine
  const declinedFlag = path.join(app.getPath('userData'), 'relocate-declined');
  if (fs.existsSync(declinedFlag)) return false;
  const dest = path.join(os.homedir(), 'Applications', path.basename(bundle));
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Не сейчас', 'Переместить'],
    defaultId: 1, cancelId: 0,
    title: 'Установка',
    message: 'Переместить Claude Swarm в «Программы» (~/Applications)?',
    detail: 'Нужно для обновлений по кнопке. Приложение перезапустится из новой папки.',
  });
  if (choice !== 1) { try { fs.writeFileSync(declinedFlag, '1'); } catch (_) {} return false; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(bundle, dest, { recursive: true });
    try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dest]); } catch (_) {}
    execFileSync('/usr/bin/open', [dest]);
    app.exit(0);
    return true;
  } catch (_) {
    return false; // relocation failed — keep running from the current location
  }
}

module.exports = { checkForUpdate, applyAsar, downloadInstaller, maybeRelocate, enabled };
```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check updater.js`
Expected: без вывода, exit 0.

- [ ] **Step 3: Commit**

```bash
git add updater.js
git commit -m "feat(апдейт): эффекты — проверка, скачивание+swap asar, self-relocation"
```

---

## Task 3: IPC в main + мост в preload

**Files:**
- Modify: `main.js` (require + IPC + whenReady)
- Modify: `preload.js`

Верификация — `node --check`, `npm test` (контракт-тест), vm-симуляция. **Приложение не запускать.**

- [ ] **Step 1: Подключить updater и вызвать relocation в whenReady**

Modify `main.js`. Найти:

```js
const git = require('./git');
```

Заменить на:

```js
const git = require('./git');
const updater = require('./updater');
```

Затем найти:

```js
app.whenReady().then(() => {
  buildMenu();
  createWindow();
});
```

Заменить на:

```js
app.whenReady().then(() => {
  // Offer to move into ~/Applications on macOS so a later asar-swap can write.
  // If it relocates, it exits — don't open a window in that case.
  if (updater.maybeRelocate()) return;
  buildMenu();
  createWindow();
});
```

- [ ] **Step 2: Добавить IPC-обработчики апдейтера**

Modify `main.js`. Найти обработчик `ipcMain.on('clipboard:write', …)` и вставить ПОСЛЕ него:

```js
// --- IPC: auto-update ---------------------------------------------------------
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  try { return await updater.checkForUpdate(); }
  catch (e) { reportMainError(e); return { kind: 'none' }; }
});
ipcMain.handle('update:apply', async (_e, { url, sha256 }) => {
  try {
    await updater.applyAsar(url, sha256, (pct) => safeSend('update:progress', pct));
    return { ok: true };
  } catch (e) { reportMainError(e); return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('update:installer', async (_e, { url, filename }) => {
  try { return await updater.downloadInstaller(url, filename); }
  catch (e) { reportMainError(e); return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.on('update:relaunch', () => { app.relaunch(); app.exit(0); });
```

- [ ] **Step 3: Добавить методы в preload**

Modify `preload.js`. Найти закрывающий блок `onAppError` и вставить перо `});` новые методы:

```js
  // Main-process errors, forwarded so they land in the in-app log viewer.
  // cb({ ts, source, level, msg }). Returns an unsubscribe fn.
  onAppError: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:error', handler);
    return () => ipcRenderer.removeListener('app:error', handler);
  },

  // --- auto-update ---
  getVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: (url, sha256) => ipcRenderer.invoke('update:apply', { url, sha256 }),
  updateDownloadInstaller: (url, filename) => ipcRenderer.invoke('update:installer', { url, filename }),
  updateRelaunch: () => ipcRenderer.send('update:relaunch'),
  onUpdateProgress: (cb) => {
    const handler = (_e, pct) => cb(pct);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
});
```

(Замена — старый блок заканчивался `onOpenHelp`/`onMenuCopy`/`onAppError` затем `});`; заменяем финальный `onAppError`-блок + `});` на версию выше с добавленными методами. Точный `old_string` — от строки `  // Main-process errors` до закрывающего `});`.)

- [ ] **Step 4: Проверки**

Run: `node --check main.js && node --check preload.js`
Expected: exit 0.

Run: `npm test`
Expected: контракт-тест зелёный (preload теперь содержит методы; renderer их ещё не зовёт — это ок, preload — надмножество).

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat(апдейт): IPC в main + методы моста в preload + relocation при старте"
```

---

## Task 4: UI апдейта в рендерере

**Files:**
- Modify: `renderer/index.html` (кнопка `#update-pill`)
- Modify: `renderer/renderer.js` (плашка, модалка, проверка, вкладка «Обновления»)
- Modify: `renderer/styles.css`

Верификация — `node --check`, vm-симуляция загрузки, контракт-тест. **Приложение не запускать.**

- [ ] **Step 1: Кнопка плашки в баре**

Modify `renderer/index.html`. Найти:

```html
      <button id="log-indicator" class="log-indicator" hidden title="Ошибки — показать логи"></button>
```

Вставить ПЕРЕД ней:

```html
      <!-- Появляется, когда доступно обновление; клик открывает модалку апдейта. -->
      <button id="update-pill" class="update-pill" hidden></button>
```

- [ ] **Step 2: Логика апдейта в renderer.js**

Modify `renderer/renderer.js`. Вставить ПЕРЕД строкой `document.getElementById('new-session-folder').addEventListener('click', createSessionInFolder);` (блок навешивания слушателей в конце файла):

```js
// --- auto-update -------------------------------------------------------------
// A pill in the status bar appears when the manifest advertises a newer version.
// Clicking it opens a modal: asar-swap (small, in-app) or a full-installer fallback
// when the runtime changed. Checks on launch + every 4h + manually from Settings.
let updateState = null; // last decideUpdate result with kind 'asar'|'installer'
const UPDATE_POLL_MS = 4 * 60 * 60 * 1000;

function snoozedVersion() { return localStorage.getItem('swarm.update.snooze') || ''; }

function renderUpdatePill() {
  const pill = document.getElementById('update-pill');
  if (!pill) return;
  const show = updateState && updateState.kind !== 'none' && updateState.version !== snoozedVersion();
  pill.hidden = !show;
  if (show) pill.textContent = '↑ Обновить ' + updateState.version;
}

async function checkForUpdate(manual) {
  let res = null;
  try { res = await window.swarm.updateCheck(); } catch (_) { res = { kind: 'none' }; }
  localStorage.setItem('swarm.update.lastCheck', String(Date.now()));
  if (res && res.kind !== 'none') { updateState = res; renderUpdatePill(); if (manual) openUpdateModal(); }
  else if (manual) { updateState = res; alertNoUpdate(); }
  return res;
}

function alertNoUpdate() {
  confirmModalInfo('Обновлений нет — установлена последняя версия.');
}

// A one-button info modal (reuses the confirm modal look).
function confirmModalInfo(message) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><div class="modal-msg"></div>
    <div class="modal-actions"><button class="modal-ok neutral">Понятно</button></div></div>`;
  overlay.querySelector('.modal-msg').textContent = message;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-ok').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
}

function openUpdateModal() {
  if (!updateState || updateState.kind === 'none') return;
  if (document.querySelector('.modal-overlay .modal.update')) return;
  const st = updateState;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal update">
      <div class="modal-title">Обновление ${st.version}</div>
      <div class="modal-msg upd-notes"></div>
      <div class="upd-progress" hidden><div class="upd-bar"></div></div>
      <div class="modal-actions">
        <button class="modal-cancel upd-later">Позже</button>
        <button class="modal-ok neutral upd-go"></button>
      </div>
    </div>`;
  overlay.querySelector('.upd-notes').textContent =
    (st.kind === 'installer' ? 'Изменился рантайм — нужен полный установщик.\n\n' : '') + (st.notes || '');
  const goBtn = overlay.querySelector('.upd-go');
  goBtn.textContent = st.kind === 'asar' ? 'Обновить и перезапустить' : 'Скачать установщик';
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.upd-later').addEventListener('click', () => {
    localStorage.setItem('swarm.update.snooze', st.version); renderUpdatePill(); close();
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !goBtn.disabled) close(); });

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    if (st.kind === 'asar') {
      const prog = overlay.querySelector('.upd-progress');
      const bar = overlay.querySelector('.upd-bar');
      prog.hidden = false;
      const off = window.swarm.onUpdateProgress((pct) => { bar.style.width = pct + '%'; });
      const res = await window.swarm.updateApply(st.asar.url, st.asar.sha256);
      off();
      if (res && res.ok) { window.swarm.updateRelaunch(); }
      else {
        prog.hidden = true; goBtn.disabled = false;
        overlay.querySelector('.upd-notes').textContent =
          'Не удалось обновить: ' + (res && res.error || 'ошибка') + '. Попробуйте полный установщик.';
      }
    } else {
      const u = st.installers[window.swarm.platform === 'win32' ? 'exe' : 'dmg'];
      const fname = (u || '').split('/').pop() || 'installer';
      const res = await window.swarm.updateDownloadInstaller(u, fname);
      close();
      confirmModalInfo(res && res.ok ? 'Установщик скачан в «Загрузки».' : 'Не удалось скачать установщик.');
    }
  });
}

// initial + periodic checks (throttled)
setTimeout(() => checkForUpdate(false), 3000);
setInterval(() => {
  const last = Number(localStorage.getItem('swarm.update.lastCheck') || 0);
  if (Date.now() - last >= UPDATE_POLL_MS) checkForUpdate(false);
}, 30 * 60 * 1000);

document.getElementById('update-pill').addEventListener('click', openUpdateModal);

```

- [ ] **Step 3: Вкладка «Обновления» в настройках**

Modify `renderer/renderer.js`, в `showSettingsModal`. Найти:

```js
        <button class="set-tab" data-tab="appearance">Вид</button>
      </div>
```

Заменить на:

```js
        <button class="set-tab" data-tab="appearance">Вид</button>
        <button class="set-tab" data-tab="updates">Обновления</button>
      </div>
```

Затем найти панель `data-panel="appearance"` — её закрывающий `</div>` перед `<div class="modal-actions">` — и вставить ПОСЛЕ панели appearance (перед `.modal-actions`) новую панель:

```js
      <div class="set-panel" data-panel="updates">
        <div class="modal-msg">Версия: <b class="upd-cur">…</b></div>
        <button class="set-check-btn upd-check">Проверить обновления</button>
        <div class="set-hint upd-status"></div>
      </div>
```

Затем в теле `showSettingsModal` (после блока appearance-wiring, перед `// Tab switching.`) добавить проводку:

```js
  const curEl = overlay.querySelector('.upd-cur');
  window.swarm.getVersion().then((v) => { if (curEl) curEl.textContent = v; }).catch(() => {});
  const updStatus = overlay.querySelector('.upd-status');
  overlay.querySelector('.upd-check').addEventListener('click', async () => {
    updStatus.textContent = 'Проверяю…';
    const res = await checkForUpdate(false);
    updStatus.textContent = (res && res.kind !== 'none')
      ? ('Доступно обновление ' + res.version)
      : 'Установлена последняя версия.';
  });
```

Также в `showTab` разрешить вкладку `updates`. Найти:

```js
  showTab(['notify', 'appearance'].includes(tab) ? tab : 'launch');
```

Заменить на:

```js
  showTab(['notify', 'appearance', 'updates'].includes(tab) ? tab : 'launch');
```

- [ ] **Step 4: Стили**

Modify `renderer/styles.css`, в конец файла:

```css
/* --- update pill + modal ------------------------------------------------- */
.update-pill {
  -webkit-app-region: no-drag;
  display: inline-flex; align-items: center;
  border: 1px solid var(--accent); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-radius: 6px; padding: 2px 8px; margin-right: 4px;
  font-size: 11px; font-weight: 600; cursor: pointer;
}
.update-pill[hidden] { display: none; }
.update-pill:hover { background: color-mix(in srgb, var(--accent) 26%, transparent); }

.modal.update { width: min(460px, 92vw); }
.modal.update .upd-notes { white-space: pre-wrap; }
.upd-progress { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; margin-bottom: 16px; }
.upd-bar { height: 100%; width: 0; background: var(--accent); transition: width 0.2s ease; }

.set-check-btn {
  -webkit-app-region: no-drag; cursor: pointer;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
  border-radius: 6px; padding: 7px 12px; font-size: 12px;
}
.set-check-btn:hover { border-color: var(--accent); color: var(--accent); }
.upd-status { margin-top: 8px; }
```

- [ ] **Step 5: Проверки**

Run: `node --check renderer/renderer.js`
Expected: exit 0.

Run: `npm test`
Expected: контракт-тест зелёный (renderer зовёт `updateCheck/updateApply/updateDownloadInstaller/updateRelaunch/onUpdateProgress/getVersion` — все есть в preload).

Run (симуляция загрузки — обнови её из scratch, добавив реальные новые методы уже покрыты реальным preload):
`node <scratch>/loadcheck2.js`
Expected: `✔ renderer.js initialized to completion` (нет throw).

- [ ] **Step 6: Commit**

```bash
git add renderer/renderer.js renderer/index.html renderer/styles.css
git commit -m "feat(апдейт): плашка «Обновить» + модалка + вкладка «Обновления» в настройках"
```

---

## Task 5: Публикация asar + манифеста в release.mjs

**Files:**
- Modify: `scripts/release.mjs`
- Modify: `package.json` (`build.files`)
- Modify: `.gitignore`

Верификация — `node --check scripts/release.mjs`. Реальную публикацию проверит следующий релиз. **Приложение не запускать.**

- [ ] **Step 1: gitignore для build-info.json**

Modify `.gitignore` — добавить строку:

```
build-info.json
```

- [ ] **Step 2: bundle updater-файлов и build-info.json**

Modify `package.json`, массив `build.files`. Найти:

```json
    "files": [
      "main.js",
      "detector.js",
      "git.js",
      "preload.js",
      "renderer/**/*",
      "package.json"
    ],
```

Заменить на:

```json
    "files": [
      "main.js",
      "detector.js",
      "git.js",
      "updater.js",
      "updater-core.js",
      "build-info.json",
      "preload.js",
      "renderer/**/*",
      "package.json"
    ],
```

- [ ] **Step 3a: добавить импорт crypto наверх release.mjs**

Modify `scripts/release.mjs`. Найти блок импортов вверху:

```js
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

Заменить на (добавлена строка crypto):

```js
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
```

- [ ] **Step 3b: генерация build-info.json + публикация asar + manifest**

Modify `scripts/release.mjs`. Найти:

```js
step('building .dmg (npm run dist) …');
```

Вставить ПЕРЕД этой строкой:

```js
// build-info.json — this build's runtimeId + read-only registry token, bundled into
// the asar. runtimeId = sha256(electronVersion|nodePtyVersion); if it changes between
// releases, app.asar isn't swap-safe and a full installer is required.
const electronVer = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version;
const nodePtyVer = JSON.parse(readFileSync('node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json', 'utf8')).version;
const runtimeId = createHash('sha256').update(`${electronVer}|${nodePtyVer}`).digest('hex');
const updateToken = process.env.UPDATE_REGISTRY_TOKEN || '';
if (!updateToken) console.warn('⚠ UPDATE_REGISTRY_TOKEN не задан — self-update будет выключен в этой сборке');
writeFileSync('build-info.json', JSON.stringify({ runtimeId, updateToken }) + '\n');
step(`build-info.json (runtimeId ${runtimeId.slice(0, 12)}…)`);
```

Затем найти конец загрузки dmg — блок:

```js
if (!put.ok) fail(`dmg upload failed: ${put.status} ${await put.text()}`);
step('dmg uploaded');
```

Вставить ПОСЛЕ него:

```js
// Publish the platform-independent app.asar + a stable manifest for the in-app updater.
const asarPath = path.join('dist', 'mac-arm64', 'Claude Swarm Lite.app', 'Contents', 'Resources', 'app.asar');
if (!existsSync(asarPath)) fail('app.asar not found at ' + asarPath);
const asarBytes = readFileSync(asarPath);
const asarSha = createHash('sha256').update(asarBytes).digest('hex');
step(`uploading app.asar (${(asarBytes.length / 1e6).toFixed(1)} MB) …`);
const asarPut = await fetch(`${base}/app.asar`, {
  method: 'PUT', headers: { 'PRIVATE-TOKEN': token }, body: asarBytes,
});
if (!asarPut.ok) fail(`asar upload failed: ${asarPut.status} ${await asarPut.text()}`);

// Notes = the changelog section we just generated for this version.
const manifest = {
  version,
  runtimeId,
  asar: { url: `${base}/app.asar`, sha256: asarSha },
  installers: {
    dmg: `${base}/${dmgFile}`,
    exe: `${base}/claude-swarm-lite-${version}-x64.exe`,
  },
  notes: commits,
  pubDate: today,
};
const latestBase = `https://${HOST}/api/v4/projects/${PROJECT_ID}/packages/generic/${PKG}/latest`;
const manPut = await fetch(`${latestBase}/manifest.json`, {
  method: 'PUT', headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
  body: JSON.stringify(manifest, null, 2),
});
if (!manPut.ok) fail(`manifest upload failed: ${manPut.status} ${await manPut.text()}`);
step('app.asar + manifest.json published');
```

(Примечание: `base` в скрипте = `.../packages/generic/${PKG}/${version}`, поэтому `${base}/app.asar` кладёт asar в `apps/<version>/app.asar` — совпадает с манифестом. `path`, `readFileSync`, `writeFileSync`, `existsSync` уже импортированы вверху скрипта; `createHash` импортируем строкой выше.)

- [ ] **Step 4: Проверка**

Run: `node --check scripts/release.mjs`
Expected: exit 0.

Run: `npm test`
Expected: всё зелёное.

- [ ] **Step 5: Commit**

```bash
git add scripts/release.mjs package.json .gitignore
git commit -m "feat(апдейт): релиз публикует app.asar + manifest.json, build-info с runtimeId"
```

---

## Финальная проверка (после всех задач)

- [ ] `npm test` — зелёный (themes, preload-contract, logstore, updater).
- [ ] `node --check` по `main.js`, `preload.js`, `renderer/renderer.js`, `updater.js`, `updater-core.js`, `scripts/release.mjs` — чисто.
- [ ] vm-симуляция `loadcheck2.js` — рендерер грузится без throw с реальным preload.
- [ ] `git status` — чисто, `build-info.json` игнорируется.
- [ ] Сообщить пользователю: перед релизом задать `UPDATE_REGISTRY_TOKEN` (read-only токен реестра, напр. `GITLAB_NPM_TOKEN`) в env рядом с `GITLAB_TOKEN`. Затем `npm run release -- minor` соберёт и опубликует asar+manifest; апдейтер заработает начиная со **следующей** версии (текущая ещё не знает про manifest, но сам manifest уже появится — апдейты «видны» со сборки, где есть updater-код).

## Заметки

- **Первый апдейт-совместимый релиз:** апдейтер работает в сборке, где есть его код (эта фича) — он появится, скажем, в 0.4.0. Установив 0.4.0, аппа будет видеть 0.4.1+ по manifest. Версии до 0.4.0 про manifest не знают — там обновление вручную (как сейчас).
- **Один asar на обе платформы** — публикуем asar из mac-сборки; он платформо-независим (node-pty вне asar).
- **Токен только read-only** — вшит в build-info.json (в asar), в git не коммитится.
- **Откат** — `app.asar.bak` рядом; при битой сборке восстановить вручную.
