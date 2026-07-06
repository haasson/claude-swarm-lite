// main.js — Electron main process.
//
// Responsibilities:
//   1. Open the window.
//   2. Own the pty (pseudo-terminal) sessions. Each session is a login shell
//      that auto-runs `claude`. node-pty is a native module and can only live
//      in the main process, not the sandboxed renderer.
//   3. Bridge data both ways over IPC:
//        renderer -> main : create / input / resize / kill
//        main -> renderer : data / exit
//
// WHY A LOGIN SHELL INSTEAD OF SPAWNING `claude` DIRECTLY:
//   When macOS launches a GUI app, the process PATH is the bare system PATH and
//   usually does NOT contain the directories your shell adds in ~/.zshrc (e.g.
//   ~/.local/bin, homebrew, nvm). Spawning `claude` directly would often fail
//   with "command not found". Spawning `$SHELL -l` (login shell) sources your
//   profile, gives the real PATH, and behaves like a normal terminal. We then
//   just type `claude` into it. Bonus: auth "just works" because it's the same
//   environment you log in from.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

/** @type {BrowserWindow | null} */
let win = null;

/** @type {Map<string, import('node-pty').IPty>} sessionId -> pty process */
const sessions = new Map();
let nextId = 1;

// The command each new tab runs once its shell is ready. Change to '' if you
// want a plain shell (and type `claude` yourself), or to something like
// 'claude --resume' later.
const START_COMMAND = 'claude';

function pickShell() {
  if (os.platform() === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

// Default working dir for sessions that don't pick a folder. Deliberately NOT
// the home dir: launching claude in ~ makes it touch TCC-protected folders
// (~/Pictures, ~/Music, ~/Documents…), triggering a barrage of macOS permission
// prompts against our unsigned app. A dedicated plain folder isn't protected.
function defaultWorkdir() {
  const dir = path.join(os.homedir(), 'ClaudeSwarm');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  return dir;
}

// Send to the renderer only if the window/frame is still alive. Late pty chunks
// arriving during quit would otherwise throw "Render frame was disposed".
function safeSend(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// --- status detection --------------------------------------------------------
// Claude Code prints no machine-readable status, so we infer it from the pty
// stream — but simply, not by scraping the TUI text:
//   While Claude works, its spinner animates, so the pty keeps emitting bytes.
//   => "bytes flowing" is a reliable "working" signal (no parsing needed).
//   => a silence gap means the agent stopped: either done, or waiting on me.
// Only in silence do we peek at the screen (a headless terminal emulator) to
// tell "waiting for a prompt" apart from "idle/done". We deliberately do NOT
// surface Claude's token counter or activity words — just the four states.
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

const ACTIVE_MS = 1200;      // bytes seen this recently => the agent is working
const TICK_MS = 300;
const SNAP_ROWS = 16;        // how many bottom screen rows to inspect
const RESIZE_GRACE_MS = 700; // after a resize, ignore the repaint burst as "activity"

// Waiting on me: a permission / confirm prompt sits statically on screen.
const RE_WAIT = /Esc to cancel|Do you want|Enter to confirm|❯\s*\d+\.\s|No, and tell Claude/i;

/** @type {Map<string, any>} id -> detector state */
const det = new Map();

function makeDetector(cols, rows) {
  return {
    term: new HeadlessTerminal({ cols: cols || 80, rows: rows || 24, scrollback: 200, allowProposedApi: true }),
    lastDataAt: Date.now(),
    resizeUntil: 0,
    status: '', detail: '', statusline: '', dead: false,
  };
}

// Read the bottom SNAP_ROWS lines of the emulator's current screen.
function snapshot(d) {
  const buf = d.term.buffer.active;
  const end = buf.length;
  const start = Math.max(0, end - SNAP_ROWS);
  const out = [];
  for (let y = start; y < end; y++) {
    const line = buf.getLine(y);
    if (line) out.push(line.translateToString(true));
  }
  return out.join('\n');
}

// The user's Claude statusline (model │ dir [bar] % │ task) renders on the very
// bottom row. Grab the lowest visible line that looks like it (has the │
// separators or the progress-bar blocks) so the app can show it in a footer.
function extractStatusline(d) {
  const buf = d.term.buffer.active;
  const end = buf.length;
  const start = Math.max(0, end - SNAP_ROWS);
  for (let y = end - 1; y >= start; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const t = line.translateToString(true).trim();
    if (t.includes('│') || /[█░]/.test(t)) return t;
  }

  return '';
}

function feedDetector(id, chunk) {
  const d = det.get(id);
  if (!d || d.dead) return;
  d.term.write(chunk);
  // A resize makes Claude repaint the whole screen — a burst of output that is
  // NOT real work. Inside the grace window after a resize we keep feeding the
  // emulator (so the screen stays correct) but don't count it as activity, so an
  // idle agent won't flash "работает" and fire a false notification.
  const now = Date.now();
  if (now >= d.resizeUntil) d.lastDataAt = now;
}

function decide(d, now) {
  // Active output => working. Only peek at the screen once it goes quiet.
  if (now - d.lastDataAt < ACTIVE_MS) {
    return { status: 'running', detail: 'работает' };
  }
  if (RE_WAIT.test(snapshot(d))) {
    return { status: 'waiting', detail: 'ждёт ответа' };
  }

  return { status: 'ready', detail: 'готов' };
}

setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  for (const [id, d] of det) {
    if (d.dead) continue;
    try {
      const next = decide(d, now);
      const statusline = extractStatusline(d);
      if (next.status !== d.status || next.detail !== d.detail || statusline !== d.statusline) {
        d.status = next.status;
        d.detail = next.detail;
        d.statusline = statusline;
        safeSend('session:status', { id, status: next.status, detail: next.detail, statusline });
      }
    } catch (_) {
      // A detector hiccup must never crash the app or freeze the UI.
    }
  }
}, TICK_MS);

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    backgroundColor: '#0d0f12',
    titleBarStyle: 'hiddenInset', // native mac traffic lights, no chrome bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer cannot touch Node directly
      nodeIntegration: false, // security baseline; all Node work is here in main
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('closed', () => {
    // Kill every child so we don't leak `claude` processes on quit.
    for (const p of sessions.values()) {
      try { p.kill(); } catch (_) {}
    }
    sessions.clear();
    win = null;
  });
}

// --- IPC: pick a working directory for a new session -------------------------
ipcMain.handle('dialog:pickFolder', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Рабочая папка для агента',
    defaultPath: defaultPath || undefined, // open where the user last was
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;

  return res.filePaths[0];
});

// --- IPC: list a project's + global custom slash commands --------------------
// Claude Code custom commands are markdown files under .claude/commands. We read
// the active session's project dir + the global ~/.claude/commands, pull the
// frontmatter (description → hint, argument-hint → needs a tee-up), and let the
// quick-menu show what's actually available for that project.
function parseFrontmatter(text) {
  const out = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  return out;
}

function readCommandsDir(baseDir, scope) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, prefix ? `${prefix}:${e.name}` : e.name); // Claude namespaces subdirs with ":"
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const base = e.name.slice(0, -3);
        let fm = {};
        try { fm = parseFrontmatter(fs.readFileSync(full, 'utf8')); } catch (_) {}
        out.push({
          name: '/' + (prefix ? `${prefix}:${base}` : base),
          hint: fm.description || '',
          arg: !!fm['argument-hint'],
          scope,
        });
      }
    }
  };
  walk(baseDir, '');

  return out;
}

// Short one-liner for the menu from a (usually long) skill description.
function shortHint(desc) {
  const first = desc.split(/(?<=[.!?])\s|—/)[0] || desc;
  const t = first.replace(/^Use\s+(when|to)\s+/i, '').trim();

  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

// Skills are directories with a SKILL.md (name + description frontmatter); each
// is invokable as /<name>. We guess "needs an argument" from the description
// showing "/name <…>" (like "/groom <issue-url>").
function readSkillsDir(baseDir, scope) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(path.join(baseDir, e.name, 'SKILL.md'), 'utf8')); } catch (_) { continue; }
    const name = fm.name || e.name;
    const desc = fm.description || '';
    const arg = new RegExp('/' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+[<«[]').test(desc);
    out.push({ name: '/' + name, hint: shortHint(desc), arg, scope });
  }

  return out;
}

ipcMain.handle('commands:list', (_e, cwd) => {
  const list = [];
  if (cwd) {
    list.push(...readCommandsDir(path.join(cwd, '.claude', 'commands'), 'project'));
    list.push(...readSkillsDir(path.join(cwd, '.claude', 'skills'), 'project'));
  }
  list.push(...readCommandsDir(path.join(os.homedir(), '.claude', 'commands'), 'global'));
  list.push(...readSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'global'));
  const seen = new Set();

  return list.filter((c) => (seen.has(c.name) ? false : seen.add(c.name))).sort((a, b) => a.name.localeCompare(b.name));
});

// --- IPC: renderer asks main to spawn a new claude session -------------------
ipcMain.handle('session:create', (_event, opts = {}) => {
  const id = String(nextId++);
  const shell = pickShell();
  const isWin = os.platform() === 'win32';
  // Restored tabs may point at a folder that no longer exists — fall back safely.
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : defaultWorkdir();

  const child = pty.spawn(shell, isWin ? [] : ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd,
    env: process.env,             // <-- inherits your Claude Code auth. Do not strip.
  });

  sessions.set(id, child);
  det.set(id, makeDetector(opts.cols, opts.rows));

  child.onData((data) => {
    feedDetector(id, data);
    safeSend('session:data', { id, data });
  });

  child.onExit(({ exitCode }) => {
    const d = det.get(id);
    if (d) d.dead = true;
    sessions.delete(id);
    safeSend('session:exit', { id, code: exitCode });
  });

  // Give the login shell a moment to finish sourcing the profile, then run claude.
  const cmd = opts.command != null ? opts.command : START_COMMAND;
  if (cmd) {
    setTimeout(() => {
      const p = sessions.get(id);
      if (p) p.write(cmd + '\r');
    }, 350);
  }

  return { id, cwd };
});

// --- IPC: keystrokes from the xterm in the renderer --------------------------
ipcMain.on('session:input', (_event, { id, data }) => {
  const p = sessions.get(id);
  if (p) p.write(data);
});

// --- IPC: the xterm was resized; keep the pty grid in sync -------------------
ipcMain.on('session:resize', (_event, { id, cols, rows }) => {
  const p = sessions.get(id);
  if (p && cols > 0 && rows > 0) {
    try { p.resize(cols, rows); } catch (_) {}
    const d = det.get(id);
    if (d && d.term) {
      try { d.term.resize(cols, rows); } catch (_) {}
      d.resizeUntil = Date.now() + RESIZE_GRACE_MS;
    }
  }
});

// --- IPC: close a tab --------------------------------------------------------
ipcMain.on('session:kill', (_event, { id }) => {
  const p = sessions.get(id);
  if (p) {
    try { p.kill(); } catch (_) {}
    sessions.delete(id);
  }
  det.delete(id);
});

// --- IPC: a UI action is about to repaint terminals; grace ALL detectors -----
// Switching tabs blurs one xterm and focuses another; with focus-reporting on,
// Claude repaints on both focus-out and focus-in. That burst is not real work,
// so we briefly stop counting activity for every session.
ipcMain.on('ui:repaint', () => {
  const until = Date.now() + RESIZE_GRACE_MS;
  for (const d of det.values()) d.resizeUntil = until;
});

// --- IPC: bring the app forward (clicked a notification) ---------------------
ipcMain.on('app:focus', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  app.focus({ steal: true });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
