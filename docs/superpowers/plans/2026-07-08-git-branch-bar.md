# Git Branch Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style bottom status bar showing the active session's git branch, with a click-menu to switch branches, fetch/pull, and an ahead/behind indicator.

**Architecture:** All git plumbing lives in a new pure-Node `git.js` module (child_process only, no Electron) so it can be exercised from a plain `node -e` script; `main.js` wires it to five IPC handlers; `preload.js` exposes `window.swarm.git.*`; the renderer draws a `#statusbar`, reflects the **active** tab's folder, polls every 2.5s, and auto-fetches every 3 min.

**Tech Stack:** Electron (main + preload + renderer), plain JS/CSS, xterm, `git` CLI via `child_process.execFile`.

**Testing note:** This project has **no automated test framework** (`package.json` has only `start`/`dist` scripts). We verify git logic with `node -e` snippets against this repo (which is itself a git repo on branch `main`), and verify the UI by running `npm start`. Do not scaffold a test runner — that is out of scope.

---

### Task 1: `git.js` — runner + `gitInfo`

**Files:**
- Create: `git.js`

- [ ] **Step 1: Create `git.js` with the runner and `gitInfo`**

```js
// git.js — all git plumbing for the branch status bar. Pure Node on purpose
// (child_process only, no Electron), so it can be required from a plain
// `node -e` script and main.js just wires the IPC.
//
// Every command runs via execFile (no shell → a branch name can't inject) with
// GIT_TERMINAL_PROMPT=0 so a repo that needs interactive credentials fails fast
// instead of hanging this background process. Auth is inherited from the same
// environment the terminal uses (Keychain / ssh-agent), so normally these run
// silently just like `git` in the shell. No UI login by design.

const { execFile } = require('child_process');

const NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

// Run a git subcommand in cwd. Never rejects — resolves { code, stdout, stderr }.
// code 0 = success; anything else (non-zero exit, ENOENT, timeout) = failure.
function runGit(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...NO_PROMPT_ENV },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

// { isRepo, branch, ahead, behind, dirty }. Non-repo / no git → { isRepo:false }.
async function gitInfo(cwd) {
  if (!cwd) return { isRepo: false };
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout !== 'true') return { isRepo: false };

  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let branch = head.stdout || 'HEAD';
  if (branch === 'HEAD') { // detached — show a short hash instead
    const short = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    branch = short.code === 0 && short.stdout ? `(${short.stdout})` : 'HEAD';
  }

  const status = await runGit(cwd, ['status', '--porcelain']);
  const dirty = status.stdout.length > 0;

  let ahead = 0, behind = 0;
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts.code === 0) { // no upstream → non-zero exit → leaves both 0
    const [l, r] = counts.stdout.split(/\s+/);
    behind = Number(l) || 0; // upstream has it, HEAD doesn't → behind
    ahead = Number(r) || 0;  // HEAD has it, upstream doesn't → ahead
  }

  return { isRepo: true, branch, ahead, behind, dirty };
}

module.exports = { runGit, gitInfo };
```

- [ ] **Step 2: Verify `gitInfo` against this repo**

Run: `node -e "require('./git').gitInfo(process.cwd()).then(i=>console.log(JSON.stringify(i)))"`
Expected: an object with `"isRepo":true`, `"branch":"main"`, and (given the current working tree has edits) `"dirty":true`. `ahead`/`behind` are numbers (often 0).

- [ ] **Step 3: Verify a non-repo returns `isRepo:false`**

Run: `node -e "require('./git').gitInfo('/tmp').then(i=>console.log(JSON.stringify(i)))"`
Expected: `{"isRepo":false}`

- [ ] **Step 4: Commit**

```bash
git add git.js
git commit -m "feat(git): pure-node git runner + gitInfo for branch bar"
```

---

### Task 2: `git.js` — branches, checkout, fetch, pull

**Files:**
- Modify: `git.js`

- [ ] **Step 1: Add the remaining functions above `module.exports`**

```js
// Local branch names. Caller marks which one is current (from gitInfo.branch).
async function gitBranches(cwd) {
  if (!cwd) return [];
  const res = await runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).filter(Boolean);
}

// Shape every mutating action the same way: { ok, error }.
function actionResult(res, fallback) {
  return { ok: res.code === 0, error: res.code === 0 ? null : (res.stderr || res.stdout || fallback) };
}

async function gitCheckout(cwd, branch) {
  return actionResult(await runGit(cwd, ['checkout', branch]), 'не удалось переключиться');
}

// Network op → longer timeout. --prune drops refs deleted on the remote.
async function gitFetch(cwd) {
  return actionResult(await runGit(cwd, ['fetch', '--prune'], 20000), 'не удалось обновить');
}

// --ff-only: never create a merge commit or leave a conflict behind our back.
// If it can't fast-forward, git errors and we surface it (user resolves in the terminal).
async function gitPull(cwd) {
  return actionResult(await runGit(cwd, ['pull', '--ff-only'], 20000), 'не удалось подтянуть');
}
```

- [ ] **Step 2: Extend the exports**

Replace the existing `module.exports` line with:

```js
module.exports = { runGit, gitInfo, gitBranches, gitCheckout, gitFetch, gitPull };
```

- [ ] **Step 3: Verify `gitBranches` against this repo**

Run: `node -e "require('./git').gitBranches(process.cwd()).then(b=>console.log(JSON.stringify(b)))"`
Expected: a JSON array of local branch names including `"main"`, e.g. `["main"]`.

- [ ] **Step 4: Commit**

```bash
git add git.js
git commit -m "feat(git): branches, checkout, fetch, pull actions"
```

---

### Task 3: Wire IPC handlers in `main.js` + package `git.js`

**Files:**
- Modify: `main.js` (require near the other requires ~line 27; handlers near the other `ipcMain.handle` blocks ~line 336)
- Modify: `package.json:17-22` (electron-builder `files` array)

- [ ] **Step 1: Require the module**

In `main.js`, immediately after the `const pty = require('@homebridge/node-pty-prebuilt-multiarch');` line, add:

```js
const git = require('./git');
```

- [ ] **Step 2: Register the five handlers**

In `main.js`, after the `ipcMain.handle('commands:list', ...)` block (ends ~line 336), add:

```js
// --- IPC: git status / actions for the active session's folder ---------------
// All logic lives in git.js (pure Node). The renderer drives which cwd to ask
// about (the active tab's folder). checkout/pull affect the real working tree
// that `claude` runs in — the same as running git yourself in that terminal.
ipcMain.handle('git:info', (_e, cwd) => git.gitInfo(cwd));
ipcMain.handle('git:branches', (_e, cwd) => git.gitBranches(cwd));
ipcMain.handle('git:fetch', (_e, cwd) => git.gitFetch(cwd));
ipcMain.handle('git:pull', (_e, cwd) => git.gitPull(cwd));
ipcMain.handle('git:checkout', (_e, cwd, branch) => git.gitCheckout(cwd, branch));
```

- [ ] **Step 3: Add `git.js` to the packaged files**

In `package.json`, the `build.files` array currently reads:

```json
    "files": [
      "main.js",
      "preload.js",
      "renderer/**/*",
      "package.json"
    ],
```

Change it to include `git.js` (otherwise the packaged app crashes on `require('./git')`):

```json
    "files": [
      "main.js",
      "git.js",
      "preload.js",
      "renderer/**/*",
      "package.json"
    ],
```

- [ ] **Step 4: Verify main.js still loads (syntax + require resolves)**

Run: `node -e "require('./git'); console.log('git module ok')"`
Expected: prints `git module ok` (main.js itself needs Electron to run, so we only smoke-test the new require target here).

- [ ] **Step 5: Commit**

```bash
git add main.js package.json
git commit -m "feat(git): wire git IPC handlers + package git.js"
```

---

### Task 4: `preload.js` — expose `window.swarm.git`

**Files:**
- Modify: `preload.js` (inside the `exposeInMainWorld('swarm', {...})` object, after `uiRepaint` ~line 38)

- [ ] **Step 1: Add the `git` sub-object**

In `preload.js`, after the `uiRepaint: () => ipcRenderer.send('ui:repaint'),` line, add:

```js
  // Git plumbing for the branch status bar. Each call targets a folder path
  // (the active session's cwd). info → { isRepo, branch, ahead, behind, dirty };
  // branches → string[]; fetch/pull/checkout → { ok, error }.
  git: {
    info:     (cwd)         => ipcRenderer.invoke('git:info', cwd),
    branches: (cwd)         => ipcRenderer.invoke('git:branches', cwd),
    fetch:    (cwd)         => ipcRenderer.invoke('git:fetch', cwd),
    pull:     (cwd)         => ipcRenderer.invoke('git:pull', cwd),
    checkout: (cwd, branch) => ipcRenderer.invoke('git:checkout', cwd, branch),
  },
```

- [ ] **Step 2: Verify syntax**

Run: `node --check preload.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(git): expose window.swarm.git in preload"
```

---

### Task 5: Status bar markup + styles + branch icon

**Files:**
- Modify: `renderer/index.html` (after `<main id="stage"></main>` ~line 35)
- Modify: `renderer/styles.css` (grid rows ~line 38-40; new bar/menu styles appended)
- Modify: `renderer/renderer.js` (ICONS object ~line 57-65)

- [ ] **Step 1: Add the status bar + git menu to the DOM**

In `renderer/index.html`, immediately after `<main id="stage"></main>`, add:

```html
  <!-- Bottom status bar: git branch of the ACTIVE session's folder (VS Code
       style). Hidden entirely when that folder is not a git repo. -->
  <footer id="statusbar">
    <button id="git-branch" class="git-branch" hidden title="Git — ветка активной сессии">
      <span class="git-ic"></span>
      <span class="git-name"></span>
      <span class="git-track"></span>
    </button>
    <span id="git-msg" class="git-msg"></span>
  </footer>

  <!-- Branch popover (built in JS, reuses .cmd-menu look, anchored to #git-branch). -->
  <div id="git-menu" class="cmd-menu hidden"></div>
```

- [ ] **Step 2: Make room for the bar in the grid**

In `renderer/styles.css`, replace these two lines (~line 39-40):

```css
body.layout-rail { grid-template-columns: 208px 1fr; grid-template-rows: 1fr; }
body.layout-top  { grid-template-columns: 1fr;        grid-template-rows: auto 1fr; }
```

with (adds a bottom `auto` row for the bar):

```css
body.layout-rail { grid-template-columns: 208px 1fr; grid-template-rows: 1fr auto; }
body.layout-top  { grid-template-columns: 1fr;        grid-template-rows: auto 1fr auto; }
```

- [ ] **Step 3: Style the bar (append to end of `renderer/styles.css`)**

```css
/* --- bottom git status bar ------------------------------------------------ */
#statusbar {
  grid-column: 1 / -1;           /* span the full window width under everything */
  display: flex;
  align-items: center;
  gap: 10px;
  height: 24px;
  padding: 0 10px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
}
.git-branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 0;
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
}
.git-branch:hover { color: var(--text); background: var(--panel-2); }
.git-branch[hidden] { display: none; }
.git-branch .git-ic { display: inline-flex; width: 13px; height: 13px; }
.git-branch .git-ic svg { width: 13px; height: 13px; }
.git-branch .git-track { color: var(--accent); letter-spacing: 0.02em; }
.git-msg { color: var(--waiting); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Add a branch icon to `ICONS`**

In `renderer/renderer.js`, inside the `ICONS` object (after the `chevron:` entry ~line 65), add:

```js
  branch: SVG('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
```

- [ ] **Step 5: Verify the app launches and shows the bar frame**

Run: `npm start`
Expected: the app window opens with a thin bar along the bottom edge (empty for now — the branch button is wired in Task 6). No console errors. Close the app.

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/styles.css renderer/renderer.js
git commit -m "feat(git): bottom status bar scaffold + branch icon"
```

---

### Task 6: Render branch, refresh on tab switch, error plaque

**Files:**
- Modify: `renderer/renderer.js` (element refs near the top ~line 15-19; new functions; call inside `activate` ~line 331)

- [ ] **Step 1: Add element refs + git state near the other `getElementById` refs (~line 19)**

After the `const cmdMenu = document.getElementById('cmd-menu');` line, add:

```js
const statusbarEl = document.getElementById('statusbar');
const gitBtn      = document.getElementById('git-branch');
const gitMenu     = document.getElementById('git-menu');
const gitMsgEl    = document.getElementById('git-msg');

let gitInfo = null;      // last git:info for the ACTIVE folder (null until first fetch)
let gitMsgTimer = null;  // auto-clear timer for the transient error plaque
```

- [ ] **Step 2: Add render + refresh + plaque helpers (place them just above the `activate` function ~line 318)**

```js
// --- git status bar ----------------------------------------------------------
// The bar reflects the ACTIVE tab's folder. Every refresh re-checks activeId
// after its await so a fast tab switch mid-request can't paint stale data.
function renderGitBar(info) {
  gitInfo = info;
  if (!info || !info.isRepo) { gitBtn.hidden = true; return; }
  gitBtn.hidden = false;
  gitBtn.querySelector('.git-ic').innerHTML = ICONS.branch;
  gitBtn.querySelector('.git-name').textContent = info.branch || '';
  const parts = [];
  if (info.behind) parts.push('↓' + info.behind);
  if (info.ahead) parts.push('↑' + info.ahead);
  if (info.dirty) parts.push('*');
  gitBtn.querySelector('.git-track').textContent = parts.join(' ');
}

async function refreshGit() {
  const forId = activeId;
  const cwd = sessions.get(activeId)?.cwd || '';
  let info = null;
  try { info = await window.swarm.git.info(cwd); } catch (_) {}
  if (forId !== activeId) return; // switched tabs during the await — drop stale
  renderGitBar(info);
}

// A short-lived message in the bar (e.g. checkout failed / needs login).
// timeout 0 keeps it until the next call (used for "обновляю…").
function showGitMsg(text, timeout = 4000) {
  if (gitMsgTimer) { clearTimeout(gitMsgTimer); gitMsgTimer = null; }
  gitMsgEl.textContent = text || '';
  if (text && timeout) gitMsgTimer = setTimeout(() => { gitMsgEl.textContent = ''; }, timeout);
}
function clearGitMsg() { showGitMsg(''); }

// git's auth failures are cryptic; map them to one clear hint. Everything else
// shows git's own stderr so real errors (e.g. conflicts) stay visible.
function gitAuthHint(err) {
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied|Host key verification/i.test(err || '')) {
    return 'нужен логин — выполните git fetch/pull в терминале';
  }
  return err || 'ошибка git';
}
```

- [ ] **Step 3: Refresh the bar whenever the active tab changes**

In `renderer/renderer.js`, inside `activate(id)`, the function currently ends with:

```js
  // Refit now that the holder is visible (fit on a hidden element is a no-op).
  requestAnimationFrame(() => { s.fit.fit(); if (!renaming) s.term.focus(); });
}
```

Add a `refreshGit();` call right before the closing brace:

```js
  // Refit now that the holder is visible (fit on a hidden element is a no-op).
  requestAnimationFrame(() => { s.fit.fit(); if (!renaming) s.term.focus(); });
  refreshGit();
}
```

- [ ] **Step 4: Verify the branch shows for a repo folder**

Run: `npm start`
Steps: use "📁 в папке…" to open a session in this project folder (`claude-swarm-lite`).
Expected: the bottom bar shows a branch icon + `main` and a `*` (working tree is dirty). Opening a session in `~/ClaudeSwarm` (non-repo) hides the branch button. Close the app.

- [ ] **Step 5: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(git): render branch in bar, refresh on tab switch"
```

---

### Task 7: Branch menu (open/close/position + actions)

**Files:**
- Modify: `renderer/renderer.js` (generalize `addCmdSection` ~line 654; new menu functions; wire click at the button-wiring block ~line 884)

- [ ] **Step 1: Generalize `addCmdSection` to accept a target menu**

In `renderer/renderer.js`, the function currently reads:

```js
function addCmdSection(title) {
  const sep = document.createElement('div');
  sep.className = 'cmd-sep';
  sep.textContent = title;
  cmdMenu.appendChild(sep);
}
```

Replace it with (default keeps every existing caller working):

```js
function addCmdSection(title, menu = cmdMenu) {
  const sep = document.createElement('div');
  sep.className = 'cmd-sep';
  sep.textContent = title;
  menu.appendChild(sep);
}
```

- [ ] **Step 2: Add the menu builder + item helpers (place above the button-wiring block, e.g. after `toggleCmdMenu` ~line 723)**

```js
// --- git branch menu ---------------------------------------------------------
function gitMenuButton(label, hint, onClick) {
  const b = document.createElement('button');
  b.className = 'cmd-item';
  b.innerHTML = '<span class="cmd-name"></span><span class="cmd-hint"></span>';
  b.querySelector('.cmd-name').textContent = label;
  b.querySelector('.cmd-hint').textContent = hint || '';
  b.addEventListener('click', onClick);
  return b;
}

async function openGitMenu() {
  if (!gitInfo || !gitInfo.isRepo) return; // nothing to show for a non-repo
  const cwd = sessions.get(activeId)?.cwd || '';
  gitMenu.innerHTML = '';

  addCmdSection(`ветка: ${gitInfo.branch}${gitInfo.behind ? ' ↓' + gitInfo.behind : ''}${gitInfo.ahead ? ' ↑' + gitInfo.ahead : ''}`, gitMenu);
  gitMenu.appendChild(gitMenuButton('Обновить', 'git fetch', onGitFetch));
  if (gitInfo.behind) gitMenu.appendChild(gitMenuButton(`Подтянуть (${gitInfo.behind})`, 'git pull --ff-only', onGitPull));

  addCmdSection('переключиться на', gitMenu);
  let branches = [];
  try { branches = await window.swarm.git.branches(cwd); } catch (_) {}
  const current = gitInfo.branch;
  if (!branches.length) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'нет локальных веток';
    gitMenu.appendChild(empty);
  } else {
    branches.forEach((b) => {
      const label = b === current ? `● ${b}` : b;
      gitMenu.appendChild(gitMenuButton(label, b === current ? 'текущая' : '', () => onGitCheckout(b)));
    });
  }

  // Anchor above the branch button (the bar sits at the bottom of the window).
  gitMenu.classList.remove('hidden');
  gitMenu.style.visibility = 'hidden';
  gitMenu.style.left = '0px';
  gitMenu.style.top = '0px';
  const r = gitBtn.getBoundingClientRect();
  const mh = gitMenu.offsetHeight;
  const mw = gitMenu.offsetWidth;
  let top = r.top - mh - 6;
  if (top < 8) top = Math.min(window.innerHeight - mh - 8, r.bottom + 6);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
  gitMenu.style.top = top + 'px';
  gitMenu.style.left = left + 'px';
  gitMenu.style.visibility = 'visible';
  setTimeout(() => document.addEventListener('mousedown', outsideCloseGit), 0);
}

function closeGitMenu() {
  gitMenu.classList.add('hidden');
  document.removeEventListener('mousedown', outsideCloseGit);
}

function outsideCloseGit(e) {
  if (!gitMenu.contains(e.target) && !gitBtn.contains(e.target)) closeGitMenu();
}

function toggleGitMenu() {
  if (gitMenu.classList.contains('hidden')) openGitMenu();
  else closeGitMenu();
}

async function onGitCheckout(branch) {
  closeGitMenu();
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  const res = await window.swarm.git.checkout(cwd, branch);
  if (!res.ok) showGitMsg(res.error || 'не удалось переключиться');
  else clearGitMsg();
  refreshGit();
}

async function onGitFetch() {
  closeGitMenu();
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  showGitMsg('обновляю…', 0);
  const res = await window.swarm.git.fetch(cwd);
  showGitMsg(res.ok ? '' : gitAuthHint(res.error));
  refreshGit();
}

async function onGitPull() {
  closeGitMenu();
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  showGitMsg('подтягиваю…', 0);
  const res = await window.swarm.git.pull(cwd);
  showGitMsg(res.ok ? '' : gitAuthHint(res.error));
  refreshGit();
}
```

- [ ] **Step 3: Wire the branch button click**

In `renderer/renderer.js`, at the button-wiring block near `cmdBtn.addEventListener('click', ...)` (~line 884), add:

```js
gitBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleGitMenu(); });
```

- [ ] **Step 4: Verify switching branches end-to-end**

Run: `npm start`
Steps: open a session in this project folder; click the `main` branch in the bar → the menu opens above the bar with "Обновить", "переключиться на", and the branch list (current marked `●`). Click "Обновить" → after a moment the ↓/↑ indicator updates (or an auth hint appears if the remote needs a login). If you have a second local branch, click it → the bar's branch name changes to it, and `git branch --show-current` in a terminal in that folder confirms the checkout. Switching to a branch with a dirty tree that blocks checkout shows git's error in the bar and does not change the branch.
Expected: all of the above; no console errors. Close the app.

- [ ] **Step 5: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(git): branch menu — switch, fetch, pull with error plaque"
```

---

### Task 8: Live polling + auto-fetch

**Files:**
- Modify: `renderer/renderer.js` (append near the other timers/bootstrap at the end of the file ~line 909)

- [ ] **Step 1: Add the poll + auto-fetch timers (append at the very end of `renderer/renderer.js`)**

```js
// Keep the branch bar live: poll the ACTIVE folder's git status every 2.5s so a
// branch switch / new changes that `claude` makes right in the terminal show up
// on their own — like VS Code's live git. Cheap: all-local git calls, active
// folder only. Skips while a menu action's transient message is showing so it
// doesn't clobber "обновляю…".
setInterval(() => {
  if (gitMsgEl.textContent) return;
  refreshGit();
}, 2500);

// Auto-fetch the active folder every 3 minutes so "↓N can pull" appears without
// user action. Network op, so it's on its own slow timer with GIT_TERMINAL_PROMPT=0
// (set in git.js) — an auth-needing repo fails fast and is ignored here (the manual
// "Обновить" button surfaces the login hint). No fetch when the folder isn't a repo.
setInterval(async () => {
  const forId = activeId;
  if (!gitInfo || !gitInfo.isRepo) return;
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  try { await window.swarm.git.fetch(cwd); } catch (_) {}
  if (forId === activeId) refreshGit();
}, 180000);
```

- [ ] **Step 2: Verify live update**

Run: `npm start`
Steps: open a session in this project folder. In a separate terminal, `cd` into the same folder and run `git checkout -b tmp-plan-test` then switch back with `git checkout main` (or edit a file to make the tree dirty).
Expected: within ~2.5s the bar reflects the change (branch name or the `*` dirty marker) without any click. Clean up the test branch: `git branch -D tmp-plan-test`. Close the app.

- [ ] **Step 3: Commit**

```bash
git add renderer/renderer.js
git commit -m "feat(git): live poll (2.5s) + auto-fetch (3min) for the branch bar"
```

---

## Self-Review

**Spec coverage:**
- Bottom bar, full width, shows active folder's branch → Tasks 5-6. ✔
- ↓N / ↑N / `*` indicators → Task 6 `renderGitBar`. ✔
- Non-repo hides the branch block → Task 6 `renderGitBar` (`gitBtn.hidden`). ✔
- Click menu reusing `.cmd-menu` style → Tasks 5 (`#git-menu`) + 7. ✔
- Menu: Обновить (fetch), Подтянуть (pull, only when behind>0), local branch list with current marked, checkout → Task 7. ✔
- git via `execFile`, `GIT_TERMINAL_PROMPT=0`, no UI login, auth-failure plaque → Tasks 1-2 (`NO_PROMPT_ENV`) + 6 (`gitAuthHint`). ✔
- IPC handlers `git:info/branches/fetch/pull/checkout` + `window.swarm.git.*` → Tasks 3-4. ✔
- Live: refresh on activate + poll 2.5s + auto-fetch 3min → Tasks 6 + 8. ✔
- Error on dirty checkout surfaced, branch unchanged → Task 7 (`onGitCheckout` shows `res.error`). ✔
- YAGNI excludes (no branch create, no remote checkout, no UI login) → honored; none implemented. ✔
- Package `git.js` for distribution → Task 3 Step 3. ✔ (gap caught: without it the packaged app would crash.)

**Placeholder scan:** No TBD/TODO/"handle errors appropriately"; every code step is complete.

**Type consistency:** `gitInfo` shape `{ isRepo, branch, ahead, behind, dirty }` is produced in Task 1 and consumed identically in `renderGitBar`/`openGitMenu`. Action shape `{ ok, error }` produced by `actionResult` (Task 2) and consumed in `onGitCheckout/onGitFetch/onGitPull` (Task 7). `window.swarm.git.{info,branches,fetch,pull,checkout}` defined in Task 4 match every call site. `addCmdSection(title, menu)` new signature is back-compatible with existing single-arg callers.
