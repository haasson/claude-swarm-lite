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

const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeImage } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Windows taskbar/Start Menu group by AppUserModelID. Must match package.json
// `appId` (NSIS shortcuts use it); without this the shell often shows a generic
// white-document icon even when the .exe has a real icon embedded.
if (process.platform === 'win32') {
  app.setAppUserModelId('io.swarm.claude-swarm-lite');
}
// Native macOS About reads CFBundleShortVersionString from the outer .app
// (installer shell). After an asar-swap that stays stale — pin About to the
// version inside package.json (same source as Settings / updater).
app.setAboutPanelOptions({
  applicationName: 'Claude Swarm Lite',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
});
// Prebuilt fork of node-pty. Load rules (Win vs Mac) live in pty-loader.js —
// Windows stays on plain unpacked require; Unix gets a scoped spawn-helper
// path fix. See that file's contract comment before changing either branch.
const pty = require('./pty-loader').loadPty({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  platform: process.platform,
});
const git = require('./git');
const updater = require('./updater');

/** @type {BrowserWindow | null} */
let win = null;
// Set once the user confirms the close dialog, so the re-issued win.close() (or a
// Cmd+Q that follows) passes through instead of re-prompting.
let allowClose = false;

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

// --- error reporting: surface main-process failures in the in-app log viewer ----
// A crash in main (pty spawn, git, an IPC handler) otherwise only prints to the
// terminal we were launched from, which regular users never see. Forward it to the
// renderer's log store so it shows up behind the red "!" in the status bar. We log
// and keep running rather than letting an uncaught error tear the process down.
function reportMainError(err) {
  const msg = (err && err.stack) || (err && err.message) || String(err);
  safeSend('app:error', { ts: new Date().toISOString().slice(11, 19), source: 'main', level: 'error', msg });
}
process.on('uncaughtException', reportMainError);
process.on('unhandledRejection', (reason) => reportMainError(reason));

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
const INPUT_GRACE_MS = 700;  // after a keystroke, ignore the echo/redraw as "activity"

// Waiting on me: a permission / confirm prompt sits on screen.
// Selection cursor before "1. Yes / 2. No": Claude Code often paints ❯ (heavy
// angle), but Cursor / some terminals use an arrow (→ ▸ ▶) or plain ">".
// Without those glyphs the tab never flips to «ждёт ответа».
const RE_WAIT = /Esc to cancel|Do you want|Enter to confirm|[❯>→➜▸►▶]\s*\d+\.\s|No, and tell Claude/i;
// Strong subset — prompt UI chrome that never appears in normal streamed output
// (numbered options, "Esc to cancel"). We trust these EVERY tick, even while bytes
// are still flowing, so a prompt is caught the instant it renders. The full RE_WAIT
// (with the looser "Do you want") stays gated behind the quiet window to avoid
// matching that phrase mid-sentence in streamed prose.
const RE_WAIT_NOW = /Esc to cancel|Enter to confirm|[❯>→➜▸►▶]\s*\d+\.\s|No, and tell Claude/i;

// Working but momentarily quiet. While Claude thinks or runs a tool it can go
// >ACTIVE_MS without emitting a byte (model call with no repaint, a slow tool),
// yet it is NOT done — its spinner line stays on screen with a LIVE elapsed
// timer: "✶ Cooking… (12s · thinking)" / "…(3s · esc to interrupt)". Idle looks
// different: a past-tense summary "Worked for 12s" (no parens) or the bare input
// box — neither carries a running "(Ns" timer. The spinner GLYPH animates through
// many chars (✶ ✽ ✻ …), so we key off the ellipsis-then-timer text, not the glyph.
// Without this, decide() falls through to "ready" on every silent work pause and
// flashes «готов» — worse, the renderer paints ready instantly but buffers the
// return to running by ~2.5s, so each false idle lingers.
const RE_RUNNING = /(?:…|\.\.\.)\s*\(\d+\s*[smh]\b|\besc to interrupt\b/i;

/** @type {Map<string, any>} id -> detector state */
const det = new Map();

function makeDetector(cols, rows) {
  return {
    term: new HeadlessTerminal({ cols: cols || 80, rows: rows || 24, scrollback: 200, allowProposedApi: true }),
    lastDataAt: Date.now(),
    graceUntil: 0,
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
  if (now >= d.graceUntil) d.lastDataAt = now;
}

function decide(d, now) {
  const snap = snapshot(d);
  // A confirm/permission prompt on screen means "waiting on me" regardless of byte
  // activity — check it EVERY tick, not only when the stream goes quiet. Otherwise a
  // background tab keeps showing "работает" while the prompt renders in bursts, and
  // only flips to "ждёт ответа" once the stream finally falls silent for ACTIVE_MS
  // (a long, ragged lag). Uses the strong prompt-chrome markers, safe mid-stream.
  if (RE_WAIT_NOW.test(snap)) {
    return { status: 'waiting', detail: 'ждёт ответа' };
  }
  // Active output => working. Only peek for the looser prompt once it goes quiet.
  if (now - d.lastDataAt < ACTIVE_MS) {
    return { status: 'running', detail: 'работает' };
  }
  if (RE_WAIT.test(snap)) {
    return { status: 'waiting', detail: 'ждёт ответа' };
  }
  // Quiet, but the spinner (with its live timer) is still on screen => the agent
  // is thinking / running a tool, not idle. Keep it "работает" instead of the
  // false "готов" flash. See RE_RUNNING above for why we match the timer text.
  if (RE_RUNNING.test(snap)) {
    return { status: 'running', detail: 'работает' };
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

// Window/taskbar chrome icon. nativeImage.createFromPath does NOT work for paths
// inside app.asar — read the bytes and build an image (fs CAN read asar).
function loadWindowIcon() {
  const iconFile = path.join(__dirname, 'build', 'icon.png');
  try {
    if (!fs.existsSync(iconFile)) return undefined;
    const img = nativeImage.createFromBuffer(fs.readFileSync(iconFile));
    return img.isEmpty() ? undefined : img;
  } catch (_) {
    return undefined;
  }
}

function createWindow() {
  const icon = loadWindowIcon();
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    backgroundColor: '#0d0f12',
    ...(icon ? { icon } : {}),
    // Frameless-with-traffic-lights is a macOS affordance. On Windows/Linux we
    // keep the native window frame (min/max/close), so only opt in on darwin.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer cannot touch Node directly
      nodeIntegration: false, // security baseline; all Node work is here in main
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Harden against accidental navigation. If a file is dropped anywhere on the
  // window that the renderer didn't preventDefault (e.g. onto the terminal/stage,
  // not the tab strip), Chromium navigates the webContents to that file:// URL and
  // renders its source as plain text — that's how the window could suddenly show
  // preload.js instead of the UI. We only ever load index.html, so block any
  // navigation and any window-open outright.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Confirm before the window closes — closing it kills every `claude` child
  // (see the 'closed' handler), so an accidental ⌘Q / red-button click would drop
  // live agents. Native sync dialog: simplest reliable gate in the main process.
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    const n = sessions.size;
    const message = n > 0
      ? `Закрыть Claude Swarm? Сейчас запущено сессий: ${n}. Все агенты завершатся.`
      : 'Закрыть Claude Swarm?';
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Отмена', 'Закрыть'],
      defaultId: 0,
      cancelId: 0,
      title: 'Закрытие приложения',
      message,
    });
    if (choice === 1) { allowClose = true; win.close(); }
  });

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

// --- IPC: git status / actions for the active session's folder ---------------
// All logic lives in git.js (pure Node). The renderer drives which cwd to ask
// about (the active tab's folder). checkout/pull affect the real working tree
// that `claude` runs in — the same as running git yourself in that terminal.
ipcMain.handle('git:info', (_e, cwd) => git.gitInfo(cwd));
ipcMain.handle('git:branches', (_e, cwd) => git.gitBranches(cwd));
ipcMain.handle('git:fetch', (_e, cwd) => git.gitFetch(cwd));
ipcMain.handle('git:pull', (_e, cwd) => git.gitPull(cwd));
ipcMain.handle('git:checkout', (_e, cwd, branch) => git.gitCheckout(cwd, branch));

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
  // Your keystrokes echo back + redraw the input box — that's you typing, not the
  // agent working. Grace it so it isn't counted as activity.
  const d = det.get(id);
  if (d) d.graceUntil = Date.now() + INPUT_GRACE_MS;
});

// --- IPC: the xterm was resized; keep the pty grid in sync -------------------
ipcMain.on('session:resize', (_event, { id, cols, rows }) => {
  const p = sessions.get(id);
  if (p && cols > 0 && rows > 0) {
    try { p.resize(cols, rows); } catch (_) {}
    const d = det.get(id);
    if (d && d.term) {
      try { d.term.resize(cols, rows); } catch (_) {}
      d.graceUntil = Date.now() + RESIZE_GRACE_MS;
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
  for (const d of det.values()) d.graceUntil = until;
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

// --- IPC: copy text to the clipboard -----------------------------------------
// The renderer sends the exact string to copy (a terminal selection or a modal's
// DOM selection). We write it via Electron's clipboard, which encodes UTF-8 to the
// pasteboard correctly. This deliberately replaces the Edit-menu's native `copy`
// role: that path read the xterm selection through a byte-mangled route and put
// UTF-8 bytes on the board tagged as MacRoman, so Cyrillic pasted as mojibake.
ipcMain.on('clipboard:write', (_event, text) => {
  try { clipboard.writeText(String(text == null ? '' : text)); } catch (_) {}
});

// --- IPC: auto-update ---------------------------------------------------------
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  try { return await updater.checkForUpdate(); }
  catch (e) { reportMainError(e); return { kind: 'none' }; }
});
ipcMain.handle('update:apply', async (_e, { url, sha256 }) => {
  try {
    const res = await updater.applyAsar(url, sha256, (pct) => safeSend('update:progress', pct));
    return res && typeof res === 'object' ? res : { ok: true };
  } catch (e) { reportMainError(e); return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('update:installer', async (_e, { url, filename }) => {
  try {
    return await updater.downloadInstaller(url, filename, (pct) => safeSend('update:progress', pct));
  } catch (e) { reportMainError(e); return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.on('update:relaunch', () => {
  // Skip the "close app?" confirm so deferred asar-swap can exit cleanly.
  allowClose = true;
  // Deferred asar-swap (Windows / macOS): helper relaunches us after exit.
  if (updater.consumeDeferredRelaunch()) { app.exit(0); return; }
  app.relaunch();
  app.exit(0);
});

// Native app menu. A custom menu REPLACES Electron's default, so we must re-add
// the standard roles (Edit gives ⌘C/⌘V/⌘A — critical in a terminal; View gives
// reload/devtools; Window gives minimize/close), then append our own "Справка".
// The Help item just asks the renderer to open the in-app help overlay.
function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      // Explicit label (not role:'editMenu') so our custom submenu — with the
      // routed Copy — is used instead of the auto-generated one. Copy is NOT the
      // stock `copy` role: that native path mangled the xterm selection's encoding
      // (Cyrillic → MacRoman mojibake). Instead ⌘C asks the renderer to copy — it
      // grabs the terminal/modal selection as a proper string and writes it through
      // clipboard:write. Cut/Paste/Select-All stay native.
      label: 'Правка',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Копировать', accelerator: 'CmdOrCtrl+C', click: () => safeSend('menu:copy') },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Справка',
      submenu: [
        { label: 'Как пользоваться', accelerator: 'CmdOrCtrl+/', click: () => safeSend('open-help') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Offer to move into ~/Applications on macOS so a later asar-swap can write.
  // If it relocates, it exits — don't open a window in that case.
  if (updater.maybeRelocate()) return;
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
