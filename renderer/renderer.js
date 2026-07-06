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

/** id -> { term, fit, holder, tab, alive, status, idleTimer } */
const sessions = new Map();
let activeId = null;
let renaming = false; // true while a card title is being edited (don't steal focus)

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

// Inferred status from main (running / ready / waiting + detail text).
window.swarm.onStatus(({ id, status, detail }) => {
  const s = sessions.get(id);
  if (s && s.alive) setStatus(id, status, detail);
});

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

async function createSession() {
  const { term, fit } = makeXterm();

  const holder = document.createElement('div');
  holder.className = 'term-holder';
  stageEl.appendChild(holder);
  term.open(holder);
  fit.fit();

  // Spawn the pty in main with the current grid size.
  // TODO(step 3): pass { cwd: <git worktree path> } to isolate each task.
  const { id } = await window.swarm.createSession({
    cols: term.cols,
    rows: term.rows,
  });

  // Wire keystrokes -> pty.
  term.onData((data) => window.swarm.sendInput(id, data));

  // Wire terminal resize -> pty resize.
  term.onResize(({ cols, rows }) => window.swarm.resize(id, cols, rows));

  // Build the tab / card.
  const tab = document.createElement('li');
  tab.className = 'tab';
  const num = sessions.size + 1;
  tab.innerHTML = `
    <span class="dot"></span>
    <span class="num">${num}</span>
    <span class="label">claude ${num}</span>
    <span class="sub">готов</span>
    <span class="close" title="Close">×</span>
  `;
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) { closeSession(id); return; }
    activate(id);
  });
  tabsEl.appendChild(tab);
  attachRename(tab.querySelector('.label'));

  sessions.set(id, { term, fit, holder, tab, alive: true, status: null });
  setStatus(id, 'ready', 'готов');
  activate(id);
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
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
  window.swarm.killSession(id);
  s.term.dispose();
  s.holder.remove();
  s.tab.remove();
  sessions.delete(id);
  renumber();
  if (activeId === id) {
    const next = sessions.keys().next();
    if (!next.done) activate(next.value);
    else activeId = null;
  }
}

// Keep the visible numbers 1..N contiguous after a close. Custom names (anything
// not matching "claude <n>") are left untouched.
function renumber() {
  let i = 1;
  for (const [, s] of sessions) {
    s.tab.querySelector('.num').textContent = i;
    const label = s.tab.querySelector('.label');
    if (/^claude \d+$/.test(label.textContent)) label.textContent = `claude ${i}`;
    i++;
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
    const num = labelEl.parentElement.querySelector('.num')?.textContent || '';
    labelEl.textContent = text || `claude ${num}`;
  });
}

// --- layout switching (rail <-> top dashboard) -------------------------------
const LAYOUTS = ['layout-rail', 'layout-top'];

function applyLayout(name) {
  if (!LAYOUTS.includes(name)) name = 'layout-rail';
  document.body.classList.remove(...LAYOUTS);
  document.body.classList.add(name);
  localStorage.setItem('swarm.layout', name);
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

// Refit the active terminal when the window changes size.
window.addEventListener('resize', () => {
  const s = sessions.get(activeId);
  if (s) s.fit.fit();
});

// Shortcuts: ⌘T new, ⌘W close, ⌘L toggle layout, ⌘1..9 jump.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 't') { e.preventDefault(); createSession(); }
  else if (e.key === 'w' && activeId) { e.preventDefault(); closeSession(activeId); }
  else if (e.key === 'l') { e.preventDefault(); toggleLayout(); }
  else if (/^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    const id = [...sessions.keys()][idx];
    if (id) { e.preventDefault(); activate(id); }
  }
});

newBtn.addEventListener('click', createSession);
layoutBtn.addEventListener('click', toggleLayout);

// Restore the last-used layout, then start with one session.
applyLayout(localStorage.getItem('swarm.layout') || 'layout-rail');
createSession();
