// renderer.js — UI logic. Runs in the sandboxed renderer, talks to main ONLY
// through window.swarm (see preload.js). No Node here.
//
// Model: one entry per session, each owning its own xterm instance + a DOM
// holder. Only the active holder is visible; the others stay mounted so their
// scrollback survives when you switch tabs.

const { Terminal } = window;                 // UMD global from xterm.js
const { FitAddon } = window.FitAddon;        // UMD global from addon-fit

// Tag the body with the host OS so the stylesheet can drop mac-only chrome
// (the empty gaps reserved for the traffic lights) on Windows/Linux.
document.body.classList.add('platform-' + (window.swarm.platform || 'unknown'));

const tabsEl     = document.getElementById('tabs');
const stageEl    = document.getElementById('stage');
const layoutBtn  = document.getElementById('layout-toggle');
const cmdBtn     = document.getElementById('cmd-menu-btn');
const cmdMenu    = document.getElementById('cmd-menu');
const gitBtn      = document.getElementById('git-branch');
const gitMenu     = document.getElementById('git-menu');
const gitMsgEl    = document.getElementById('git-msg');

let gitInfo = null;      // last git:info for the ACTIVE folder (null until first fetch)
let gitMsgTimer = null;  // auto-clear timer for the transient error plaque

// Built-in commands sent into the ACTIVE session on click, grouped by purpose.
// Item flags (all optional):
//   confirm — show a modal first (destructive commands like /clear)
//   arg     — command needs an argument: we type "cmd " (no Enter) and focus the
//             terminal so you finish typing it yourself (keeps Claude's own
//             argument autocomplete). Without arg, we send "cmd\r" to run now.
// Project/global custom commands are auto-discovered separately (see openCmdMenu).
const BUILTIN_GROUPS = [
  {
    title: 'контекст',
    items: [
      { name: '/compact', hint: 'сжать историю' },
      { name: '/context', hint: 'показать контекст' },
      { name: '/clear', hint: 'очистить контекст', confirm: 'Очистить весь контекст активного агента? История разговора будет стёрта безвозвратно.' },
    ],
  },
  {
    title: 'расход',
    items: [
      { name: '/cost', hint: 'расход токенов' },
      { name: '/usage', hint: 'лимиты плана' },
    ],
  },
  {
    title: 'сессия',
    items: [
      { name: '/model', hint: 'сменить модель' },
      { name: '/resume', hint: 'вернуться к диалогу' },
    ],
  },
];

// Inline Lucide icons (MIT) — no dependency/bundler needed. currentColor-styled.
const SVG = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  plus: SVG('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  folderPlus: SVG('<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>'),
  command: SVG('<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>'),
  layout: SVG('<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'),
  folder: SVG('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>'),
  chevron: SVG('<path d="m6 9 6 6 6-6"/>'),
  branch: SVG('<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  gear: SVG('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
};

// Put an icon + a folder name into an element (name via text node, never markup).
function setFolderLabel(el, name) {
  el.innerHTML = ICONS.folder;
  el.appendChild(document.createTextNode(' ' + name));
}

/** id -> { term, fit, holder, tab, alive, status, idleTimer } */
const sessions = new Map();
let activeId = null;
let renaming = false;       // true while a card title is being edited (don't steal focus)
let notifyEnabled = true;   // master switch: system notifications for background agents
// Finer notification prefs (all default on), editable in Settings → Уведомления.
let notifySound = localStorage.getItem('swarm.notifySound') !== '0';   // play a sound
let notifyOnReady = localStorage.getItem('swarm.notifyReady') !== '0';   // ping on «готов»
let notifyOnWaiting = localStorage.getItem('swarm.notifyWaiting') !== '0'; // ping on «ждёт ответа»
// Off by default: normally the tab you're actively watching in a focused window
// isn't pinged (it'd be noise). Turn on to get pings for it too.
let notifyActive = localStorage.getItem('swarm.notifyActive') === '1';
let lastFolder = null;      // last folder picked, so the dialog reopens there
const collapsedFolders = new Set(); // folders whose group is collapsed in the sidebar
const folderOrder = [];             // cwd keys in display order (folders + loners)
const withinOrder = new Map();      // cwd -> [session id, …] in display order
let drag = null;                    // active drag: { kind: 'card'|'unit', id?, cwd }
let dropped = false;                // whether the current drag committed a drop

// --- status ------------------------------------------------------------------
// Status is inferred from the pty stream in main.js (see the detector there)
// and pushed over onStatus. The renderer just paints it: `status` drives the
// color class, `detail` the subline text ("Baking… · 385 ток", "завис? 9с", …).
function setStatus(id, status, detail) {
  const s = sessions.get(id);
  if (!s) return;
  if (status && s.status !== status) {
    s.status = status;
    s.tab.classList.remove('status-ready', 'status-running', 'status-waiting', 'status-dead');
    s.tab.classList.add('status-' + status);
    if (s.sumDot) s.sumDot.className = 'sum-dot status-' + status; // collapsed-group dot
  }
  if (detail != null) {
    const sub = s.tab.querySelector('.sub');
    if (sub) sub.textContent = detail;
  }
}

// --- one shared subscription for pty output; route by id ---------------------
window.swarm.onData(({ id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});

// Inferred status from main (running / ready / waiting + detail + statusline).
const RUN_BUFFER_MS = 2500; // delay painting "работает" so sub-buffer blips never show

window.swarm.onStatus(({ id, status, detail, statusline }) => {
  const s = sessions.get(id);
  if (!s || !s.alive) return;

  if (statusline != null) { s.statusline = statusline; updateCtx(s); }

  if (status === 'running') {
    if (s.runningSince == null) s.runningSince = Date.now(); // real start of this run
    // Delay the orange paint; a blip that clears within the buffer never shows.
    if (s.status !== 'running' && !s.runTimer) {
      s.runTimer = setTimeout(() => {
        s.runTimer = null;
        if (s.alive) setStatus(id, 'running', 'работает');
      }, RUN_BUFFER_MS);
    }

    return; // notifications only fire on the ready/waiting transitions below
  }

  // ready / waiting: cancel any pending orange, then apply immediately.
  if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
  const prev = s.status;
  setStatus(id, status, detail);
  maybeNotify(id, prev, status);
  s.runningSince = null;
});

// Show the session's context fill on its card, parsed from the Claude statusline
// (which contains "… ████░░ 65% …"). Colored green/amber/red by how full it is.
function updateCtx(s) {
  const ctx = s.tab.querySelector('.ctx');
  const m = (s.statusline || '').match(/(\d+)\s*%/);
  if (!m) { ctx.hidden = true; return; }
  const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
  ctx.hidden = false;
  ctx.querySelector('.ctx-fill').style.width = pct + '%';
  ctx.querySelector('.ctx-num').textContent = pct + '%';
  ctx.classList.remove('ctx-lo', 'ctx-mid', 'ctx-hi');
  ctx.classList.add(pct < 50 ? 'ctx-lo' : pct < 80 ? 'ctx-mid' : 'ctx-hi');
}

window.swarm.onExit(({ id }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.alive = false;
  if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
  setStatus(id, 'dead', 'завершён');
  // Claude/the shell has exited. Leave the pane so output stays readable.
  s.term.write('\r\n\x1b[2m[session ended — close the tab]\x1b[0m\r\n');
});

function makeXterm() {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 10000,
    theme: {
      background: '#0d0f12',
      foreground: '#c9d1d9',
      cursor: '#3fd0c9',
      selectionBackground: '#2b3640',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

// Launch config for NEW tabs: which agent CLI to run (`cmd`) + extra flags
// (`flags`). Both are user-editable in Settings (⚙) and applied globally to every
// new session. A new tab types `${cmd} ${flags}` once its shell is ready.
//   cmd   — 'claude', or an alias like 'cld'/'claude-glm' (your own shell alias
//           that points claude-code at a different config / ANTHROPIC_BASE_URL).
//   flags — e.g. '--dangerously-skip-permissions', '--resume', '--model sonnet'.
let launch = loadLaunch();

function loadLaunch() {
  let cmd = localStorage.getItem('swarm.launchCmd');
  let flags = localStorage.getItem('swarm.launchFlags');
  // Migrate the old single-string 'swarm.startCommand' (command + flags in one)
  // into the split cmd/flags model, once. First token = launcher, rest = flags.
  if (cmd == null && flags == null) {
    const legacy = (localStorage.getItem('swarm.startCommand') || 'claude').trim();
    const sp = legacy.indexOf(' ');
    cmd = sp === -1 ? legacy : legacy.slice(0, sp);
    flags = sp === -1 ? '' : legacy.slice(sp + 1).trim();
  }
  return { cmd: (cmd || '').trim() || 'claude', flags: (flags || '').trim() };
}

// The full launch line for a new tab, e.g. 'cld --dangerously-skip-permissions'.
function launchCommand() {
  return (launch.cmd + ' ' + launch.flags).trim();
}

function saveLaunch() {
  localStorage.setItem('swarm.launchCmd', launch.cmd);
  localStorage.setItem('swarm.launchFlags', launch.flags);
}

// Convenience: also LEARN the launcher from what you actually type at a shell
// prompt, so switching to e.g. `claude-corp` by hand becomes the default for new
// tabs without opening Settings. We match a known launcher STEM (not any word) so
// `ls`/`git commit -m claude`/chat messages aren't mistaken for a launch command.
// We only adopt the STEM (first token), never the flags — flags are a deliberate
// Settings choice and typing a bare `claude` in some tab must not wipe them. An
// alias outside this list (e.g. `cld`) won't auto-learn — set it once in Settings.
const AGENT_CMD_RE = /^\s*(?:claude|glm|deepseek|codex|gemini|aider|qwen|kimi|opencode|crush|amp|droid)[\w-]*(?:\s+--?[\w-]+(?:=\S+)?)*\s*$/i;
function rememberStartCommand(line) {
  const t = line.trim();
  if (!AGENT_CMD_RE.test(t)) return;
  const cmd = t.split(/\s+/)[0];
  if (cmd === launch.cmd) return;
  launch = { cmd, flags: launch.flags };
  saveLaunch();
}

async function createSession(opts = {}) {
  const { term, fit } = makeXterm();

  const holder = document.createElement('div');
  holder.className = 'term-holder';
  stageEl.appendChild(holder);
  term.open(holder);
  // xterm reserves space for a scrollbar via `viewport.offsetWidth - scrollArea || 15`.
  // On macOS the scrollbar is overlay (0 layout width), so that measures 0 and the
  // `|| 15` fallback reserves a phantom 15px strip on the right that's just empty —
  // FitAddon subtracts it from the width, so the grid never fills the last ~2 cols.
  // We use an overlay scrollbar (styled thin in CSS, floats over content), so reserve
  // nothing and let the terminal fill the width.
  if (term._core && term._core.viewport) term._core.viewport.scrollBarWidth = 0;
  fit.fit();

  // A plain new session inherits the folder of the one you're currently on;
  // opts.cwd (folder picker) overrides. Main falls back to the default folder.
  const cwd = opts.cwd || sessions.get(activeId)?.cwd;
  const { id, cwd: resolvedCwd } = await window.swarm.createSession({
    cols: term.cols,
    rows: term.rows,
    cwd,
    command: opts.command != null ? opts.command : launchCommand(),
  });

  // Wire keystrokes -> pty. Strip focus in/out reports (CSI I / CSI O): with
  // focus-reporting on, every focus change (clicking the terminal or a tab) makes
  // Claude repaint, and that burst was being read as "работает" for a moment. A
  // multi-tab pulpit doesn't need Claude to track terminal focus.
  // Track what you type at the shell so we can remember a `claude…` launcher and
  // reuse it for new tabs. Buffer printable chars until Enter; backspace pops;
  // an escape sequence (arrow keys / history) resets the line — see the caveat on
  // rememberStartCommand. inEsc persists across chunks (a seq can split).
  let cmdBuf = '';
  let inEsc = false;
  term.onData((data) => {
    const clean = data.replace(/\x1b\[[IO]/g, '');
    if (!clean) return;
    for (const ch of clean) {
      if (inEsc) { if (/[a-zA-Z~]/.test(ch)) inEsc = false; continue; }
      if (ch === '\x1b') { inEsc = true; cmdBuf = ''; }
      else if (ch === '\r' || ch === '\n') { rememberStartCommand(cmdBuf); cmdBuf = ''; }
      else if (ch === '\x7f' || ch === '\b') cmdBuf = cmdBuf.slice(0, -1);
      else if (ch >= ' ') cmdBuf += ch;
    }
    window.swarm.sendInput(id, clean);
  });

  // Wire terminal resize -> pty resize.
  term.onResize(({ cols, rows }) => window.swarm.resize(id, cols, rows));

  // Build the tab / card.
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.innerHTML = `
    <span class="dot"></span>
    <span class="body">
      <span class="label"></span>
      <span class="ctx" hidden>
        <span class="ctx-track"><span class="ctx-fill"></span></span>
        <span class="ctx-num"></span>
      </span>
      <span class="sub">готов</span>
    </span>
    <span class="close" title="Close">×</span>
  `;
  // Name: restored name if given, else folder basename (de-duplicated).
  const folderName = resolvedCwd ? basename(resolvedCwd) : 'claude';
  tab.querySelector('.label').textContent = opts.name || defaultName(folderName);
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) { requestCloseSession(id); return; }
    activate(id);
  });
  tab.dataset.sid = id;
  tab.draggable = true;
  tab.addEventListener('dragstart', (e) => {
    const cwd = sessions.get(id)?.cwd || '';
    // A card in a multi-tab group reorders within the folder; a loner is itself a
    // top-level unit (reorders among folders/loners, never into a folder).
    const inGroup = (withinOrder.get(cwd) || []).length > 1;
    startDrag(e, inGroup ? { kind: 'card', id, cwd } : { kind: 'unit', cwd });
  });
  attachRename(tab.querySelector('.label'));

  sessions.set(id, { term, fit, holder, tab, alive: true, status: null, cwd: resolvedCwd, id, sumDot: null });
  const okey = resolvedCwd || '';
  if (!folderOrder.includes(okey)) folderOrder.push(okey);
  if (!withinOrder.has(okey)) withinOrder.set(okey, []);
  if (!withinOrder.get(okey).includes(id)) withinOrder.get(okey).push(id);
  relayoutTabs();
  persistTabs();
  setStatus(id, 'ready', 'готов');
  activate(id);
}

// Last path segment of a folder path, used as the tab label.
function basename(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);

  return parts.length ? parts[parts.length - 1] : p;
}

// Pick a folder, then open a session whose cwd is that folder (label = its name).
// The dialog opens at the current session's folder (or the last one picked).
async function createSessionInFolder() {
  const base = sessions.get(activeId)?.cwd || lastFolder || undefined;
  const dir = await window.swarm.pickFolder(base);
  if (!dir) return;
  lastFolder = dir;
  createSession({ cwd: dir });
}

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

// True when a fetch/pull failed because git needs credentials we can't prompt
// for (our background git runs with GIT_TERMINAL_PROMPT=0, so it fails fast
// instead of hanging). Non-technical users get a friendly modal explaining how
// to log in — not the raw git error.
function isGitAuthError(err) {
  return /could not read Username|could not read Password|Authentication failed|Invalid username or password|terminal prompts disabled|no credential|Permission denied|Host key verification|Could not read from remote repository|fatal: Authentication/i.test(err || '');
}

// Plain-language dialog shown when a remote sync (fetch/pull) needs a git login.
// Local branch work (view/switch) never triggers this — only server sync does.
function showGitLoginModal() {
  if (document.querySelector('.modal-overlay .modal.git-login')) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal git-login">
      <div class="modal-title">Нужен вход в Git</div>
      <div class="modal-msg">
        Чтобы <b>обновить</b> или <b>подтянуть</b> изменения с сервера, на этом
        компьютере нужно войти в Git. Просмотр и переключение веток работают и
        без входа — это делается локально.<br><br>
        <b>Как войти (один раз):</b> открой любую вкладку с агентом и набери в
        терминале <code>git fetch</code>. Git спросит логин и пароль (или токен) —
        введи их, дальше он запомнит. Если не знаешь данные — попроси того, кто
        настраивал проект.
      </div>
      <div class="modal-actions"><button class="modal-ok neutral">Понятно</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const btn = overlay.querySelector('.modal-ok');
  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const onKey = (ev) => { if (ev.key === 'Escape' || ev.key === 'Enter') { ev.preventDefault(); close(); } };
  btn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  btn.focus();
}

// --- settings (⚙) ------------------------------------------------------------
// Tabbed modal. "Запуск": which agent CLI + flags a NEW tab runs (global; open
// tabs untouched — see loadLaunch/launchCommand/saveLaunch). "Уведомления": the
// system-notification prefs (mirrors the 🔔 quick-mute; see maybeNotify).
function showSettingsModal(tab) {
  if (document.querySelector('.modal-overlay .modal.settings')) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal settings">
      <div class="set-tabs" role="tablist">
        <button class="set-tab" data-tab="launch">Запуск</button>
        <button class="set-tab" data-tab="notify">Уведомления</button>
      </div>

      <div class="set-panel" data-panel="launch">
        <div class="modal-msg">Применяется ко всем <b>новым</b> вкладкам. Уже открытые сессии не трогаем.</div>
        <label class="set-field">
          <span class="set-label">Команда запуска</span>
          <input class="set-input" id="set-cmd" type="text" spellcheck="false"
                 autocapitalize="off" autocorrect="off" placeholder="claude" />
          <span class="set-hint">Какой агент запускать: <code>claude</code>, <code>cld</code>, <code>claude-glm</code>…</span>
        </label>
        <label class="set-field">
          <span class="set-label">Доп. флаги</span>
          <input class="set-input" id="set-flags" type="text" spellcheck="false"
                 autocapitalize="off" autocorrect="off" placeholder="напр. --dangerously-skip-permissions" />
          <span class="set-hint">Дописываются к команде: <code>--dangerously-skip-permissions</code>, <code>--resume</code>, <code>--model sonnet</code>…</span>
        </label>
        <div class="set-preview">Новая вкладка запустит: <code class="set-preview-cmd"></code></div>
      </div>

      <div class="set-panel" data-panel="notify">
        <div class="modal-msg">Пинг, когда фоновая вкладка закончила или ждёт ответа.</div>
        <label class="set-check">
          <input type="checkbox" id="set-notify-on" />
          <span class="set-check-tx"><b>Уведомления включены</b></span>
        </label>
        <div class="set-sub">
          <label class="set-check">
            <input type="checkbox" id="set-notify-ready" />
            <span class="set-check-tx">Когда агент закончил — <span class="set-mono">готов</span></span>
          </label>
          <label class="set-check">
            <input type="checkbox" id="set-notify-waiting" />
            <span class="set-check-tx">Когда агент ждёт ответа — <span class="set-mono">ждёт ответа</span></span>
          </label>
          <label class="set-check">
            <input type="checkbox" id="set-notify-active" />
            <span class="set-check-tx">Пинговать и активную вкладку в фокусе
              <span class="set-check-sub">обычно её не трогаем — вы и так на неё смотрите</span></span>
          </label>
          <label class="set-check">
            <input type="checkbox" id="set-notify-sound" />
            <span class="set-check-tx">Звук</span>
          </label>
        </div>
      </div>

      <div class="modal-actions">
        <button class="modal-cancel">Отмена</button>
        <button class="modal-ok neutral">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Launch panel wiring + live preview.
  const cmdI = overlay.querySelector('#set-cmd');
  const flagsI = overlay.querySelector('#set-flags');
  const preview = overlay.querySelector('.set-preview-cmd');
  cmdI.value = launch.cmd;
  flagsI.value = launch.flags;
  const renderPreview = () => {
    preview.textContent = ((cmdI.value.trim() || 'claude') + ' ' + flagsI.value.trim()).trim();
  };
  renderPreview();
  cmdI.addEventListener('input', renderPreview);
  flagsI.addEventListener('input', renderPreview);

  // Notify panel wiring: the sub-options grey out when the master is off.
  const onI = overlay.querySelector('#set-notify-on');
  const readyI = overlay.querySelector('#set-notify-ready');
  const waitingI = overlay.querySelector('#set-notify-waiting');
  const activeI = overlay.querySelector('#set-notify-active');
  const soundI = overlay.querySelector('#set-notify-sound');
  onI.checked = notifyEnabled;
  readyI.checked = notifyOnReady;
  waitingI.checked = notifyOnWaiting;
  activeI.checked = notifyActive;
  soundI.checked = notifySound;
  const syncNotify = () => {
    overlay.querySelector('.set-sub').classList.toggle('disabled', !onI.checked);
  };
  syncNotify();
  onI.addEventListener('change', syncNotify);

  // Tab switching.
  const panels = overlay.querySelectorAll('.set-panel');
  const tabs = overlay.querySelectorAll('.set-tab');
  const showTab = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    if (name === 'launch') { cmdI.focus(); cmdI.select(); }
  };
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  showTab(tab === 'notify' ? 'notify' : 'launch');

  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const save = () => {
    launch = { cmd: cmdI.value.trim() || 'claude', flags: flagsI.value.trim() };
    saveLaunch();
    notifyOnReady = readyI.checked;
    notifyOnWaiting = waitingI.checked;
    notifyActive = activeI.checked;
    notifySound = soundI.checked;
    localStorage.setItem('swarm.notifyReady', notifyOnReady ? '1' : '0');
    localStorage.setItem('swarm.notifyWaiting', notifyOnWaiting ? '1' : '0');
    localStorage.setItem('swarm.notifyActive', notifyActive ? '1' : '0');
    localStorage.setItem('swarm.notifySound', notifySound ? '1' : '0');
    applyNotify(onI.checked); // master switch (persists swarm.notify)
    close();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); save(); }
  };
  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.querySelector('.modal-ok').addEventListener('click', save);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
  // Switching focus makes both the old and new terminals repaint — grace all
  // detectors so that burst isn't read as activity (would flash "работает").
  window.swarm.uiRepaint();
  for (const [, other] of sessions) {
    other.holder.classList.remove('active');
    other.tab.classList.remove('active');
  }
  s.holder.classList.add('active');
  s.tab.classList.add('active');
  activeId = id;
  // Refit now that the holder is visible (fit on a hidden element is a no-op).
  requestAnimationFrame(() => { s.fit.fit(); if (!renaming) s.term.focus(); });
  refreshGit();
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.runTimer) { clearTimeout(s.runTimer); s.runTimer = null; }
  window.swarm.killSession(id);
  s.term.dispose();
  s.holder.remove();
  s.tab.remove();
  sessions.delete(id);
  const key = s.cwd || '';
  const arr = withinOrder.get(key);
  if (arr) {
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) {
      withinOrder.delete(key);
      const fi = folderOrder.indexOf(key);
      if (fi >= 0) folderOrder.splice(fi, 1);
    }
  }
  relayoutTabs();
  persistTabs();
  if (activeId === id) {
    const next = sessions.keys().next();
    if (!next.done) { activate(next.value); }
    else { activeId = null; }
  }
}

// Ask before closing — the × is easy to hit by accident.
async function requestCloseSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  const name = s.tab.querySelector('.label').textContent;
  if (await confirmModal(`Закрыть «${name}»? Сессия агента завершится.`, 'Закрыть')) closeSession(id);
}

// Save the open tabs (folder + name) so they can be restored next launch.
// Session content isn't persisted — each restored tab spawns a fresh claude.
function persistTabs() {
  const out = [];
  for (const u of orderedUnits()) {
    for (const s of u.list) out.push({ cwd: s.cwd || null, name: s.tab.querySelector('.label').textContent });
  }
  localStorage.setItem('swarm.tabs', JSON.stringify(out));
}

// Sessions in display order, grouped into units (a folder or a loner) by cwd.
function orderedUnits() {
  const units = [];
  for (const cwd of folderOrder) {
    const list = (withinOrder.get(cwd) || []).filter((id) => sessions.has(id)).map((id) => sessions.get(id));
    if (list.length) units.push({ cwd, list });
  }

  return units;
}

// A default name for a new session: the folder basename, de-duplicated.
function defaultName(folderName) {
  const base = folderName || 'claude';
  const taken = new Set([...sessions.values()].map((s) => s.tab.querySelector('.label').textContent));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;

  return `${base} ${i}`;
}

// Rebuild the sidebar, grouping sessions by working folder. A folder with one
// session shows the folder on the card; 2+ get boxed under a folder header.
// Existing tab elements are re-appended (listeners preserved).
function relayoutTabs() {
  for (const s of sessions.values()) s.sumDot = null; // reset; reassigned for collapsed groups
  tabsEl.innerHTML = '';
  // Every working folder is a group (with a header) — even with a single tab.
  for (const { cwd, list } of orderedUnits()) {
    const folderName = cwd ? basename(cwd) : 'claude';
    const collapsed = collapsedFolders.has(cwd);
    const grp = document.createElement('div');
    grp.className = 'tab-group' + (collapsed ? ' collapsed' : '');
    grp.dataset.cwd = cwd;

    const head = document.createElement('div');
    head.className = 'group-head';
    head.title = collapsed ? 'Развернуть' : 'Свернуть';
    head.dataset.cwd = cwd;
    head.draggable = true;
    head.addEventListener('dragstart', (e) => startDrag(e, { kind: 'unit', cwd }));
    const chev = document.createElement('span');
    chev.className = 'group-chev';
    chev.innerHTML = ICONS.chevron;
    const nameEl = document.createElement('span');
    nameEl.className = 'group-name';
    setFolderLabel(nameEl, folderName);
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = list.length;
    const dots = document.createElement('span');
    dots.className = 'group-dots'; // shown only when collapsed
    for (const s of list) {
      const d = document.createElement('span');
      d.className = 'sum-dot status-' + (s.status || 'ready');
      d.title = s.tab.querySelector('.label').textContent;
      d.addEventListener('click', (e) => { e.stopPropagation(); activate(s.id); });
      s.sumDot = d;
      dots.appendChild(d);
    }
    // Per-folder "+" — opens a new session in this folder, without collapsing it.
    const add = document.createElement('span');
    add.className = 'group-add';
    add.title = 'Новая сессия в этой папке';
    add.innerHTML = ICONS.plus;
    add.addEventListener('click', (e) => { e.stopPropagation(); createSession({ cwd: cwd || undefined }); });
    head.append(chev, nameEl, count, dots, add);
    head.addEventListener('click', () => toggleFolder(cwd));

    const inner = document.createElement('div');
    inner.className = 'group-tabs';
    inner.addEventListener('dragover', (e) => onWithinDragOver(e, cwd));
    inner.addEventListener('drop', (e) => onWithinDrop(e, cwd));
    for (const s of list) {
      s.tab.dataset.cwd = cwd;
      inner.appendChild(s.tab);
    }
    grp.append(head, inner);
    tabsEl.appendChild(grp);
  }
}

// --- drag & drop: live reflow (dragged item leaves a faint slot; others move) -
function axisOf() {
  return document.body.classList.contains('layout-top') ? 'x' : 'y';
}

// The element the dragged item should be inserted before (null => append).
function dropBefore(els, x, y) {
  const axis = axisOf();
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const mid = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
    if ((axis === 'x' ? x : y) < mid) return el;
  }

  return null;
}

function startDrag(e, payload) {
  drag = payload;
  dropped = false;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', payload.id || payload.cwd); } catch (_) {}
  // The in-list element becomes a dashed empty slot; a card, or the whole group
  // for a folder drag. Deferred so the browser's drag image (what follows the
  // cursor) is captured with full content first — then it turns into the slot.
  const ghost = payload.kind === 'unit' ? e.currentTarget.closest('.tab-group') : e.currentTarget;
  const el = ghost || e.currentTarget;
  setTimeout(() => { if (drag) el.classList.add('dragging'); }, 0);
}

function endDrag() {
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  if (!dropped) relayoutTabs(); // drop didn't land — restore original order
  dropped = false;
  drag = null;
}

// Reorder cards within one folder group by live-reflow.
function onWithinDragOver(e, cwd) {
  if (!drag || drag.kind !== 'card' || drag.cwd !== cwd) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  const container = e.currentTarget;
  const draggedEl = sessions.get(drag.id)?.tab;
  if (!draggedEl) return;
  const others = [...container.querySelectorAll('.tab')].filter((el) => el !== draggedEl);
  const before = dropBefore(others, e.clientX, e.clientY);
  if (before) container.insertBefore(draggedEl, before);
  else container.appendChild(draggedEl);
}

function onWithinDrop(e, cwd) {
  if (!drag || drag.kind !== 'card' || drag.cwd !== cwd) return;
  e.preventDefault();
  e.stopPropagation();
  // DOM is already in the target order — sync it into the data model.
  withinOrder.set(cwd, [...e.currentTarget.querySelectorAll('.tab')].map((el) => el.dataset.sid));
  dropped = true;
  persistTabs();
}

// Collapse / expand a folder group (persisted).
function toggleFolder(cwd) {
  if (collapsedFolders.has(cwd)) collapsedFolders.delete(cwd);
  else collapsedFolders.add(cwd);
  localStorage.setItem('swarm.collapsed', JSON.stringify([...collapsedFolders]));
  relayoutTabs();
}

// Double-click a card title to rename it (e.g. what that agent is working on).
// Enter/Escape or blur commits; empty reverts to the default "claude <n>".
function attachRename(labelEl) {
  labelEl.title = 'Двойной клик — переименовать';
  labelEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    renaming = true;
    const t = labelEl.closest('.tab');
    if (t) t.draggable = false; // don't drag while editing the title
    labelEl.contentEditable = 'plaintext-only';
    labelEl.spellcheck = false;
    labelEl.focus();
    const range = document.createRange();
    range.selectNodeContents(labelEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  labelEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); labelEl.blur(); }
    e.stopPropagation(); // don't fire app shortcuts (⌘T etc.) while typing
  });
  labelEl.addEventListener('blur', () => {
    renaming = false;
    labelEl.contentEditable = 'false';
    const t = labelEl.closest('.tab');
    if (t) t.draggable = true;
    const text = labelEl.textContent.replace(/\s+/g, ' ').trim();
    labelEl.textContent = text || 'claude';
    persistTabs();
  });
}

// --- layout switching (rail <-> top dashboard) -------------------------------
const LAYOUTS = ['layout-rail', 'layout-top'];

function applyLayout(name) {
  if (!LAYOUTS.includes(name)) name = 'layout-rail';
  document.body.classList.remove(...LAYOUTS);
  document.body.classList.add(name);
  localStorage.setItem('swarm.layout', name);
  window.swarm.uiRepaint(); // the relayout repaints terminals — don't count it as activity
  // Chrome changed size => the stage did too; refit the visible terminal.
  requestAnimationFrame(() => {
    const s = sessions.get(activeId);
    if (s) s.fit.fit();
  });
}

function toggleLayout() {
  const cur = document.body.classList.contains('layout-top') ? 'layout-top' : 'layout-rail';
  applyLayout(cur === 'layout-top' ? 'layout-rail' : 'layout-top');
}

// --- notifications -----------------------------------------------------------
// Ping when a BACKGROUND agent needs attention: it started waiting on me, or it
// finished (running -> ready). The agent you're actively watching in a focused
// window is never pinged — that would just be noise.
const MIN_RUN_MS = 3000; // a "run" shorter than this is a repaint blip, not real work
const NOTIFY_GRACE_MS = 10000; // stay silent for the first 10s after launch
const appStartedAt = Date.now(); // for the launch grace above

function maybeNotify(id, prev, next) {
  if (!notifyEnabled || prev === next) return;
  // Silent for the first NOTIFY_GRACE_MS after launch: restoring tabs respawns
  // claude in every folder, and those startup status flips aren't worth a ping.
  if (Date.now() - appStartedAt < NOTIFY_GRACE_MS) return;
  // By default you're already looking at THIS tab in a focused window — no need to
  // ping it. BACKGROUND tabs still ping even while the window is focused: that's the
  // whole point of a multi-agent pulpit — you can't watch every tab at once, so a
  // tab that finishes / starts waiting must announce itself. (An earlier version
  // muted ALL tabs whenever the window was focused, which silenced pings entirely
  // for anyone who keeps the pulpit open — the common case.) The notifyActive pref
  // opts back in to pinging the active/focused tab too.
  if (!notifyActive && id === activeId && document.hasFocus()) return;
  const s = sessions.get(id);

  let body = null;
  if (next === 'waiting') {
    if (!notifyOnWaiting) return;
    body = 'ждёт ответа';
  } else if (next === 'ready' && prev === 'running') {
    if (!notifyOnReady) return;
    // Only ping "готов" if the agent actually worked for a bit — a sub-3s "run"
    // is almost always a false blip (a focus/repaint), not a finished task.
    if (s && s.runningSince && Date.now() - s.runningSince < MIN_RUN_MS) return;
    body = 'готов';
  }
  if (!body) return;

  const name = s?.tab.querySelector('.label')?.textContent?.trim() || `claude ${id}`;
  const note = new Notification(name, { body, silent: !notifySound });
  note.onclick = () => {
    window.swarm.focusApp();
    activate(id);
  };
}

function applyNotify(enabled) {
  notifyEnabled = enabled;
  localStorage.setItem('swarm.notify', enabled ? '1' : '0');
}

// --- quick commands ----------------------------------------------------------
// Send a slash command into the ACTIVE session, as if typed + Enter.
function runQuickCommand(text) {
  const s = sessions.get(activeId);
  if (!s || !s.alive) return;
  window.swarm.sendInput(activeId, text + '\r');
  requestAnimationFrame(() => s.term.focus());
}

async function onQuickCommand(item) {
  closeCmdMenu();
  const s = sessions.get(activeId);
  if (!s || !s.alive) return;
  if (item.confirm && !(await confirmModal(item.confirm))) return;
  if (item.arg) {
    // Tee up "cmd " (no Enter) and hand focus back — you type the argument.
    window.swarm.sendInput(activeId, item.name + ' ');
    requestAnimationFrame(() => s.term.focus());

    return;
  }
  runQuickCommand(item.name);
}

function addCmdSection(title, menu = cmdMenu) {
  const sep = document.createElement('div');
  sep.className = 'cmd-sep';
  sep.textContent = title;
  menu.appendChild(sep);
}

function cmdItemButton(item) {
  const b = document.createElement('button');
  b.className = 'cmd-item' + (item.confirm ? ' danger' : '');
  b.innerHTML = '<span class="cmd-name"></span><span class="cmd-hint"></span>';
  // "…" on arg commands signals they tee up for you to finish typing.
  b.querySelector('.cmd-name').textContent = item.arg ? `${item.name} …` : item.name;
  b.querySelector('.cmd-hint').textContent = item.hint || '';
  b.addEventListener('click', () => onQuickCommand(item));

  return b;
}

async function openCmdMenu() {
  cmdMenu.innerHTML = '';
  const s = sessions.get(activeId);
  if (!s || !s.alive) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'нет активного агента';
    cmdMenu.appendChild(empty);
  } else {
    // Built-in commands grouped by purpose, then this project's custom commands.
    for (const g of BUILTIN_GROUPS) {
      addCmdSection(g.title);
      g.items.forEach((item) => cmdMenu.appendChild(cmdItemButton(item)));
    }
    let discovered = [];
    try { discovered = await window.swarm.listCommands(s.cwd); } catch (_) {}
    if (discovered.length) {
      addCmdSection('кастомные команды');
      discovered.forEach((item) => cmdMenu.appendChild(cmdItemButton(item)));
    }
  }
  cmdMenu.classList.remove('hidden');
  // Anchor to the burger button; flip above / clamp to viewport as needed.
  cmdMenu.style.visibility = 'hidden';
  cmdMenu.style.left = '0px';
  cmdMenu.style.top = '0px';
  const r = cmdBtn.getBoundingClientRect();
  const mh = cmdMenu.offsetHeight;
  const mw = cmdMenu.offsetWidth;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
  cmdMenu.style.top = top + 'px';
  cmdMenu.style.left = left + 'px';
  cmdMenu.style.visibility = 'visible';
  setTimeout(() => document.addEventListener('mousedown', outsideCloseCmd), 0);
}

function closeCmdMenu() {
  cmdMenu.classList.add('hidden');
  document.removeEventListener('mousedown', outsideCloseCmd);
}

function outsideCloseCmd(e) {
  if (!cmdMenu.contains(e.target) && e.target !== cmdBtn) closeCmdMenu();
}

function toggleCmdMenu() {
  if (cmdMenu.classList.contains('hidden')) openCmdMenu();
  else closeCmdMenu();
}

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
  if (res.ok) clearGitMsg();
  else if (isGitAuthError(res.error)) { clearGitMsg(); showGitLoginModal(); }
  else showGitMsg(res.error || 'не удалось обновить');
  refreshGit();
}

async function onGitPull() {
  closeGitMenu();
  const cwd = sessions.get(activeId)?.cwd;
  if (!cwd) return;
  showGitMsg('подтягиваю…', 0);
  const res = await window.swarm.git.pull(cwd);
  if (res.ok) clearGitMsg();
  else if (isGitAuthError(res.error)) { clearGitMsg(); showGitLoginModal(); }
  else showGitMsg(res.error || 'не удалось подтянуть');
  refreshGit();
}

// Dark themed confirm dialog. Resolves true/false.
function confirmModal(message, okLabel = 'Выполнить') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-msg"></div>
        <div class="modal-actions">
          <button class="modal-cancel">Отмена</button>
          <button class="modal-ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-msg').textContent = message;
    overlay.querySelector('.modal-ok').textContent = okLabel;
    document.body.appendChild(overlay);

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
      else if (ev.key === 'Enter') { ev.preventDefault(); close(true); }
    };
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-ok').addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('.modal-ok').focus();
  });
}

// Built-in help. Static, author-trusted HTML (no user input) — focuses on the
// gotchas: what a tab really is, what the statuses mean, and — the big one — that
// the app runs whatever `claude` your environment resolves to, so account/model
// selection lives in your shell, not here.
const HELP_HTML = `
  <h3>Claude Swarm Lite</h3>
  <p>Пульт для нескольких сессий Claude Code разом. Каждая вкладка — <b>настоящий процесс <code>claude</code></b> в твоём login-шелле; аппа его только показывает и переключает. Токенов она не хранит.</p>

  <h4>Статусы вкладок</h4>
  <ul>
    <li><b>🔵 работает</b> — агент думает/генерит (идёт поток вывода).</li>
    <li><b>🟡 ждёт ответа</b> — на экране вопрос или запрос разрешения, нужен твой ввод.</li>
    <li><b>⚪ готов</b> — простаивает у пустого промпта.</li>
    <li><b>⚫ завершена</b> — процесс закрыт.</li>
  </ul>

  <h4>Git-ветка (панель снизу)</h4>
  <p>Внизу окна видно, на какой <b>ветке</b> git находится папка активной вкладки. Значки рядом: <code>*</code> — есть несохранённые (незакоммиченные) правки; <code>↓N</code> — на сервере N новых коммитов, которые можно забрать; <code>↑N</code> — у тебя N своих, ещё не отправленных.</p>
  <ul>
    <li><b>Клик по ветке</b> — меню: <b>Обновить</b> (свериться с сервером), <b>Подтянуть</b> (забрать новое — появляется, когда есть <code>↓</code>), и список веток. Клик по ветке — переключиться на неё. Ветки идут по свежести: недавние сверху.</li>
    <li>Просмотр и переключение веток работают <b>всегда</b>, даже без входа в git — это локально.</li>
    <li><b>Обновить / Подтянуть</b> ходят на сервер и требуют <b>входа в git</b>. Если ты не залогинен, выскочит окно с объяснением, как войти (это делается один раз в терминале вкладки).</li>
    <li>Если папка вкладки — не git-репозиторий, панель ветки пустая.</li>
  </ul>

  <h4>Горячие клавиши</h4>
  <ul>
    <li><code>⌘T</code> — новая вкладка (папка по умолчанию) · <code>⌘O</code> — с выбором папки</li>
    <li><code>⌘K</code> — палитра команд · <code>⌘L</code> — раскладка · <code>⌘W</code> — закрыть вкладку</li>
    <li><code>⌘1…9</code> — прыжок на вкладку · <code>⌘/</code> — эта справка</li>
  </ul>

  <h4>Какой аккаунт / модель запускается</h4>
  <p>Аппа наследует окружение от того, <b>кто её запустил</b>, и просто печатает <code>claude</code>. Значит выбор аккаунта живёт в твоём шелле, не в аппе:</p>
  <ul>
    <li><b>Надёжно:</b> пропиши нужные <code>export</code> в <code>~/.zshrc</code>. Каждая вкладка поднимает login-шелл, сорсит <code>.zshrc</code> и подхватывает их — даже при запуске из Finder.</li>
    <li>Запуск из Finder без настроек в <code>.zshrc</code> = голое окружение → дефолтный <code>claude</code> (может быть разлогинен).</li>
    <li>Правки <code>.zshrc</code> подхватывают <b>новые</b> вкладки; уже открытые — нет.</li>
  </ul>

  <h4>Другие модели (GLM, DeepSeek…)</h4>
  <p>Если модель подключена через <code>ANTHROPIC_BASE_URL</code> — это <b>тот же Claude Code</b>, просто другой бэкенд. Всё работает без изменений: команды (<code>/compact</code>, <code>/clear</code>, <code>/usage</code>) — это фичи CLI, а не модели. Токен и base URL держи в <code>~/.zshrc</code>, <b>не в аппе</b>.</p>

  <h4>Запоминание команды запуска</h4>
  <p>Вбей в терминал вкладки нужный лончер <b>руками</b> (<code>claude-my</code>, <code>claude-glm</code>, <code>glm</code>…) — аппа запомнит его и будет открывать новые вкладки им (переживает перезапуск). Ловится только набранное/вставленное: команда, поднятая из истории стрелкой ↑, не запомнится — набери разок целиком.</p>
`;

function openHelp() {
  if (document.querySelector('.modal-overlay .modal.help')) return; // already open
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal help">
      <div class="help-body">${HELP_HTML}</div>
      <div class="modal-actions"><button class="modal-ok help-close">Понятно</button></div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  overlay.querySelector('.help-close').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('.help-close').focus();
}

// Opened from the native "Справка" app-menu item (⌘/), handled in main.
window.swarm.onOpenHelp(openHelp);

// Refit the active terminal when the window changes size.
window.addEventListener('resize', () => {
  const s = sessions.get(activeId);
  if (s) s.fit.fit();
});

// Refit when the terminal area itself resizes — e.g. the top chrome bar grows or
// shrinks as cards gain context meters, wrap long names, or groups collapse.
// Without this the terminal overflows its container and clips the last line.
const stageObserver = new ResizeObserver(() => {
  const s = sessions.get(activeId);
  if (s) s.fit.fit();
});
stageObserver.observe(stageEl);

// Top-level reorder: dragging a loner card or a group head reorders the units
// (folders + loners). A unit never drops inside a folder (that handler ignores it).
tabsEl.addEventListener('dragover', (e) => {
  if (!drag || drag.kind !== 'unit') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const dragged = [...tabsEl.children].find((el) => el.dataset.cwd === drag.cwd);
  if (!dragged) return;
  const others = [...tabsEl.children].filter((el) => el.dataset.cwd && el !== dragged);
  const before = dropBefore(others, e.clientX, e.clientY);
  if (before) tabsEl.insertBefore(dragged, before);
  else tabsEl.appendChild(dragged);
});
tabsEl.addEventListener('drop', (e) => {
  if (!drag || drag.kind !== 'unit') return;
  e.preventDefault();
  folderOrder.length = 0;
  folderOrder.push(...[...tabsEl.children].filter((el) => el.dataset.cwd).map((el) => el.dataset.cwd));
  dropped = true;
  persistTabs();
});
document.addEventListener('dragend', endDrag);

// Swallow the browser default for any drag/drop that isn't over the tab strip
// (those handlers do their own preventDefault + reordering). Without this, a file
// dropped onto the terminal/stage makes Chromium navigate the page to that file
// and render its raw source — the window would then show e.g. preload.js, not the
// UI. main.js also blocks will-navigate as a backstop.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Shortcuts: ⌘T new, ⌘W close, ⌘L toggle layout, ⌘1..9 jump.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 't') { e.preventDefault(); createSession(); }
  else if (e.key === 'o') { e.preventDefault(); createSessionInFolder(); }
  else if (e.key === 'k') { e.preventDefault(); toggleCmdMenu(); }
  else if (e.key === ',') { e.preventDefault(); showSettingsModal(); }
  else if (e.key === 'w' && activeId) { e.preventDefault(); requestCloseSession(activeId); }
  else if (e.key === 'l') { e.preventDefault(); toggleLayout(); }
  else if (/^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    const id = [...sessions.keys()][idx];
    if (id) { e.preventDefault(); activate(id); }
  }
});

document.getElementById('new-session-folder').addEventListener('click', createSessionInFolder);
layoutBtn.addEventListener('click', toggleLayout);
document.getElementById('settings-btn').addEventListener('click', () => showSettingsModal());
cmdBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCmdMenu(); });
gitBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleGitMenu(); });

// Set the button icons (Lucide SVGs).
document.querySelector('#new-session-folder .ic').innerHTML = ICONS.folderPlus;
document.querySelector('#cmd-menu-btn .ic').innerHTML = ICONS.command;
document.querySelector('#layout-toggle .ic').innerHTML = ICONS.layout;
document.querySelector('#settings-btn .ic').innerHTML = ICONS.gear;

// Restore the previous session's tabs (folders + names), or start with one.
// Content isn't restored — each tab spawns a fresh claude in its folder.
async function restoreOrStart() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('swarm.tabs') || '[]'); } catch (_) {}
  saved = Array.isArray(saved) ? saved.filter((t) => t && t.cwd) : [];
  if (!saved.length) { createSession(); return; }
  for (const t of saved) await createSession({ cwd: t.cwd, name: t.name });
  const first = sessions.keys().next();
  if (!first.done) activate(first.value);
}

// Restore saved prefs, then the tabs.
applyLayout(localStorage.getItem('swarm.layout') || 'layout-rail');
applyNotify(localStorage.getItem('swarm.notify') !== '0'); // master notifications on/off
try { JSON.parse(localStorage.getItem('swarm.collapsed') || '[]').forEach((c) => collapsedFolders.add(c)); } catch (_) {}
restoreOrStart();

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
