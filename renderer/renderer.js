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
  bell: SVG('<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>'),
  bellOff: SVG('<path d="M8.7 3A6 6 0 0 1 18 8c0 2.1.4 3.8 1 5"/><path d="M20.7 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6.03 6.03 0 0 1 .2-1.5"/><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="m2 2 20 20"/>'),
  layout: SVG('<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'),
  folder: SVG('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>'),
  chevron: SVG('<path d="m6 9 6 6 6-6"/>'),
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
let notifyEnabled = true;   // system notifications when a background agent needs attention
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

  // Wire keystrokes -> pty. Strip focus in/out reports (CSI I / CSI O): with
  // focus-reporting on, every focus change (clicking the terminal or a tab) makes
  // Claude repaint, and that burst was being read as "работает" for a moment. A
  // multi-tab pulpit doesn't need Claude to track terminal focus.
  term.onData((data) => {
    const clean = data.replace(/\x1b\[[IO]/g, '');
    if (clean) window.swarm.sendInput(id, clean);
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
    head.append(chev, nameEl, count, dots);
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

function maybeNotify(id, prev, next) {
  if (!notifyEnabled || prev === next) return;
  const s = sessions.get(id);

  let body = null;
  if (next === 'waiting') {
    body = 'ждёт ответа';
  } else if (next === 'ready' && prev === 'running') {
    // Only ping "готов" if the agent actually worked for a bit — a sub-3s "run"
    // is almost always a false blip (a focus/repaint), not a finished task.
    if (s && s.runningSince && Date.now() - s.runningSince < MIN_RUN_MS) return;
    body = 'готов';
  }
  if (!body) return;

  // You're already looking at this one — no need to ping.
  if (id === activeId && document.hasFocus()) return;

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
  btn.querySelector('.ic').innerHTML = enabled ? ICONS.bell : ICONS.bellOff;
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

function addCmdSection(title) {
  const sep = document.createElement('div');
  sep.className = 'cmd-sep';
  sep.textContent = title;
  cmdMenu.appendChild(sep);
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

// Shortcuts: ⌘T new, ⌘W close, ⌘L toggle layout, ⌘1..9 jump.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 't') { e.preventDefault(); createSession(); }
  else if (e.key === 'o') { e.preventDefault(); createSessionInFolder(); }
  else if (e.key === 'k') { e.preventDefault(); toggleCmdMenu(); }
  else if (e.key === 'w' && activeId) { e.preventDefault(); requestCloseSession(activeId); }
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

// Set the button icons (Lucide SVGs).
document.querySelector('#new-session .ic').innerHTML = ICONS.plus;
document.querySelector('#new-session-folder .ic').innerHTML = ICONS.folderPlus;
document.querySelector('#cmd-menu-btn .ic').innerHTML = ICONS.command;
document.querySelector('#layout-toggle .ic').innerHTML = ICONS.layout;

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
applyNotify(localStorage.getItem('swarm.notify') !== '0'); // also sets the bell icon
try { JSON.parse(localStorage.getItem('swarm.collapsed') || '[]').forEach((c) => collapsedFolders.add(c)); } catch (_) {}
restoreOrStart();
