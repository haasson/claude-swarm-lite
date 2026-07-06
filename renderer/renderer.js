// renderer.js — UI logic. Runs in the sandboxed renderer, talks to main ONLY
// through window.swarm (see preload.js). No Node here.
//
// Model: one entry per session, each owning its own xterm instance + a DOM
// holder. Only the active holder is visible; the others stay mounted so their
// scrollback survives when you switch tabs.

const { Terminal } = window;                 // UMD global from xterm.js
const { FitAddon } = window.FitAddon;        // UMD global from addon-fit

const tabsEl     = document.getElementById('tabs');
const stageEl    = document.getElementById('stage');
const newBtn     = document.getElementById('new-session');
const layoutBtn  = document.getElementById('layout-toggle');
const cmdBtn     = document.getElementById('cmd-menu-btn');
const cmdMenu    = document.getElementById('cmd-menu');
const statusbarEl = document.getElementById('statusbar');

// Quick commands sent into the ACTIVE session on click. Flags (all optional):
//   confirm — show a modal first (destructive commands like /clear)
//   arg     — command needs an argument: we type "cmd " (no Enter) and focus the
//             terminal so you finish typing it yourself (keeps Claude's own
//             argument autocomplete). Without arg, we send "cmd\r" to run now.
// Extend freely.
const QUICK_COMMANDS = [
  { name: '/compact', hint: 'сжать историю' },
  { name: '/clear', hint: 'очистить контекст', confirm: 'Очистить весь контекст активного агента? История разговора будет стёрта безвозвратно.' },
  { name: '/context', hint: 'показать контекст' },
  { name: '/cost', hint: 'расход токенов' },
  { name: '/model', hint: 'сменить модель' },
  { name: '/resume', hint: 'вернуться к диалогу' },
  { name: '/groom', hint: 'дописать номер задачи', arg: true },
];

/** id -> { term, fit, holder, tab, alive, status, idleTimer } */
const sessions = new Map();
let activeId = null;
let renaming = false;       // true while a card title is being edited (don't steal focus)
let notifyEnabled = true;   // system notifications when a background agent needs attention
let lastFolder = null;      // last folder picked, so the dialog reopens there

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
window.swarm.onStatus(({ id, status, detail, statusline }) => {
  const s = sessions.get(id);
  if (!s || !s.alive) return;
  const prev = s.status;
  setStatus(id, status, detail);
  if (statusline != null) s.statusline = statusline;
  if (id === activeId) renderStatusbar();
  maybeNotify(id, prev, status);
});

// Bottom bar shows the ACTIVE session's Claude statusline (model · dir · ctx · task).
function renderStatusbar() {
  const s = sessions.get(activeId);
  statusbarEl.textContent = s && s.statusline ? s.statusline : '';
}

window.swarm.onExit(({ id }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.alive = false;
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

async function createSession(opts = {}) {
  const { term, fit } = makeXterm();

  const holder = document.createElement('div');
  holder.className = 'term-holder';
  stageEl.appendChild(holder);
  term.open(holder);
  fit.fit();

  // A plain new session inherits the folder of the one you're currently on;
  // opts.cwd (folder picker) overrides. Main falls back to the default folder.
  const cwd = opts.cwd || sessions.get(activeId)?.cwd;
  const { id, cwd: resolvedCwd } = await window.swarm.createSession({
    cols: term.cols,
    rows: term.rows,
    cwd,
  });

  // Wire keystrokes -> pty.
  term.onData((data) => window.swarm.sendInput(id, data));

  // Wire terminal resize -> pty resize.
  term.onResize(({ cols, rows }) => window.swarm.resize(id, cols, rows));

  // Build the tab / card.
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.innerHTML = `
    <span class="dot"></span>
    <span class="body">
      <span class="label"></span>
      <span class="folder"></span>
      <span class="sub">готов</span>
    </span>
    <span class="close" title="Close">×</span>
  `;
  // Default name = folder basename (de-duplicated). textContent, never innerHTML.
  const folderName = resolvedCwd ? basename(resolvedCwd) : 'claude';
  tab.querySelector('.label').textContent = defaultName(folderName);
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) { closeSession(id); return; }
    activate(id);
  });
  attachRename(tab.querySelector('.label'));

  sessions.set(id, { term, fit, holder, tab, alive: true, status: null, cwd: resolvedCwd });
  relayoutTabs();
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
  renderStatusbar();
  // Refit now that the holder is visible (fit on a hidden element is a no-op).
  requestAnimationFrame(() => { s.fit.fit(); if (!renaming) s.term.focus(); });
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  window.swarm.killSession(id);
  s.term.dispose();
  s.holder.remove();
  s.tab.remove();
  sessions.delete(id);
  relayoutTabs();
  if (activeId === id) {
    const next = sessions.keys().next();
    if (!next.done) { activate(next.value); }
    else { activeId = null; renderStatusbar(); }
  }
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
  const groups = new Map(); // cwd -> [session, …], first-seen order
  for (const s of sessions.values()) {
    const key = s.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  tabsEl.innerHTML = '';
  for (const [cwd, list] of groups) {
    const folderName = cwd ? basename(cwd) : '';
    if (list.length === 1) {
      list[0].tab.querySelector('.folder').textContent = folderName; // shown on the lone card
      tabsEl.appendChild(list[0].tab);
    } else {
      const grp = document.createElement('div');
      grp.className = 'tab-group';
      const head = document.createElement('div');
      head.className = 'group-head';
      head.textContent = folderName || '—';
      const inner = document.createElement('div');
      inner.className = 'group-tabs';
      for (const s of list) {
        s.tab.querySelector('.folder').textContent = ''; // folder is in the header
        inner.appendChild(s.tab);
      }
      grp.appendChild(head);
      grp.appendChild(inner);
      tabsEl.appendChild(grp);
    }
  }
}

// Double-click a card title to rename it (e.g. what that agent is working on).
// Enter/Escape or blur commits; empty reverts to the default "claude <n>".
function attachRename(labelEl) {
  labelEl.title = 'Двойной клик — переименовать';
  labelEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    renaming = true;
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
    const text = labelEl.textContent.replace(/\s+/g, ' ').trim();
    labelEl.textContent = text || 'claude';
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
function maybeNotify(id, prev, next) {
  if (!notifyEnabled || prev === next) return;

  let body = null;
  if (next === 'waiting') body = 'ждёт ответа';
  else if (next === 'ready' && prev === 'running') body = 'готов';
  if (!body) return;

  // You're already looking at this one — no need to ping.
  if (id === activeId && document.hasFocus()) return;

  const s = sessions.get(id);
  const name = s?.tab.querySelector('.label')?.textContent?.trim() || `claude ${id}`;
  const note = new Notification(name, { body, silent: false });
  note.onclick = () => {
    window.swarm.focusApp();
    activate(id);
  };
}

function applyNotify(enabled) {
  notifyEnabled = enabled;
  localStorage.setItem('swarm.notify', enabled ? '1' : '0');
  const btn = document.getElementById('notify-toggle');
  btn.querySelector('.ic').textContent = enabled ? '🔔' : '🔕';
  btn.querySelector('.tx').textContent = enabled ? 'alerts' : 'muted';
  btn.classList.toggle('muted', !enabled);
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

function buildCmdMenu() {
  cmdMenu.innerHTML = '';
  if (!activeId || !sessions.get(activeId)?.alive) {
    const empty = document.createElement('div');
    empty.className = 'cmd-empty';
    empty.textContent = 'нет активного агента';
    cmdMenu.appendChild(empty);

    return;
  }
  QUICK_COMMANDS.forEach((item) => {
    const b = document.createElement('button');
    b.className = 'cmd-item' + (item.confirm ? ' danger' : '');
    b.innerHTML = '<span class="cmd-name"></span><span class="cmd-hint"></span>';
    // "…" on arg commands signals they tee up for you to finish typing.
    b.querySelector('.cmd-name').textContent = item.arg ? `${item.name} …` : item.name;
    b.querySelector('.cmd-hint').textContent = item.hint || '';
    b.addEventListener('click', () => onQuickCommand(item));
    cmdMenu.appendChild(b);
  });
}

function openCmdMenu() {
  buildCmdMenu();
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

// Dark themed confirm dialog. Resolves true/false.
function confirmModal(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-msg"></div>
        <div class="modal-actions">
          <button class="modal-cancel">Отмена</button>
          <button class="modal-ok">Выполнить</button>
        </div>
      </div>`;
    overlay.querySelector('.modal-msg').textContent = message;
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

// Refit the active terminal when the window changes size.
window.addEventListener('resize', () => {
  const s = sessions.get(activeId);
  if (s) s.fit.fit();
});

// Shortcuts: ⌘T new, ⌘W close, ⌘L toggle layout, ⌘1..9 jump.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 't') { e.preventDefault(); createSession(); }
  else if (e.key === 'o') { e.preventDefault(); createSessionInFolder(); }
  else if (e.key === 'k') { e.preventDefault(); toggleCmdMenu(); }
  else if (e.key === 'w' && activeId) { e.preventDefault(); closeSession(activeId); }
  else if (e.key === 'l') { e.preventDefault(); toggleLayout(); }
  else if (/^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    const id = [...sessions.keys()][idx];
    if (id) { e.preventDefault(); activate(id); }
  }
});

newBtn.addEventListener('click', () => createSession());
document.getElementById('new-session-folder').addEventListener('click', createSessionInFolder);
layoutBtn.addEventListener('click', toggleLayout);
document.getElementById('notify-toggle').addEventListener('click', () => applyNotify(!notifyEnabled));
cmdBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCmdMenu(); });

// Restore saved prefs, then start with one session.
applyLayout(localStorage.getItem('swarm.layout') || 'layout-rail');
applyNotify(localStorage.getItem('swarm.notify') !== '0');
createSession();
