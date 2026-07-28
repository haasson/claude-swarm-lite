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

const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeImage, shell } = require('electron');
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
const resume = require('./renderer/resume'); // UMD: exports { supports, stemOf, ... } under Node

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

// --- context progress bar, out of the box -----------------------------------
// The per-tab context bar is scraped from a "NN%" in Claude's statusline (see
// renderer updateCtx). Stock Claude prints no such line, so a fresh install would
// show no bar. Rather than ask every user to configure `statusLine` by hand, we
// SHIP one (swarm-statusline.js) and inject it into each Claude launch via
// `--settings`. That touches no file in the user's own config and needs no
// separately-installed Node — the script runs under Electron-as-node.
//
// Path to the JSON settings file we hand to `claude --settings`. null if
// provisioning failed (then we simply skip injection and behave as before).
let STATUSLINE_SETTINGS = null;
const { hookSettings } = require('./hook-config');
const { DEFAULT_ASK_PHRASES, normalizePhrases, phraseSources, buildAskMatcher, asksWith } = require('./ask-phrases');
let STATUSLINE_COMMAND = null; // the provisioned statusline launcher command
let HOOK_COMMAND = null;       // the provisioned hook launcher command
// Opt-in: precise status via Claude hooks. Off by default; the renderer pushes the
// user's saved pref on startup (settings:hooks) and rewrites swarm-settings.json.
// Scoped to swarm sessions via --settings — never the user's global config.
let HOOKS_ENABLED = false;

// Copy a bundled script onto a real path (fs CAN read inside app.asar, but Node
// can't exec from there) and return a launcher command that runs our own binary as
// Node. Per-OS because inline `VAR=1 cmd` is POSIX-only; cmd.exe needs `set`.
function provisionNodeLauncher(dir, srcName, base) {
  const scriptDst = path.join(dir, path.basename(srcName));
  fs.copyFileSync(path.join(__dirname, srcName), scriptDst);
  const exe = process.execPath;
  if (os.platform() === 'win32') {
    const launcher = path.join(dir, base + '.cmd');
    fs.writeFileSync(launcher, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${scriptDst}"\r\n`);
    return `"${launcher}"`;
  }
  const launcher = path.join(dir, base + '.sh');
  fs.writeFileSync(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" "${scriptDst}"\n`, { mode: 0o755 });
  return `sh "${launcher}"`;
}

// (Re)write swarm-settings.json: always the statusline; the hooks block only when
// the user opted in. Called at startup and whenever the hooks pref changes — new
// Claude sessions read the flag at launch, so a change takes effect on the next one.
function writeSwarmSettings() {
  if (!STATUSLINE_COMMAND) return;
  const settings = { statusLine: { type: 'command', command: STATUSLINE_COMMAND, padding: 0 } };
  if (HOOKS_ENABLED && HOOK_COMMAND) settings.hooks = hookSettings(HOOK_COMMAND);
  const settingsPath = path.join(app.getPath('userData'), 'swarm-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  STATUSLINE_SETTINGS = settingsPath;
}

// The «agent is calling me» phrases (Settings → Запуск). One list, two readers: the
// screen detector in this process, and the Stop hook — which is a separate process,
// so it gets the COMPILED matcher through swarm-phrases.json, written next to the
// hook script in userData. See ask-phrases.js.
let ASK_PHRASES = DEFAULT_ASK_PHRASES.slice();
let ASK_MATCHER = buildAskMatcher(ASK_PHRASES);     // for the transcript probe

function applyAskPhrases() {
  setAskPhrases(ASK_PHRASES);                       // in-process (screen scraping)
  ASK_MATCHER = buildAskMatcher(ASK_PHRASES);
  const phrases = normalizePhrases(ASK_PHRASES);
  const body = Object.assign({ phrases }, phraseSources(phrases));
  fs.writeFileSync(path.join(app.getPath('userData'), 'swarm-phrases.json'),
    JSON.stringify(body, null, 2));                 // for the hook process
}

function provisionStatusline() {
  const dir = app.getPath('userData');
  // Rewritten every launch so upgrades take.
  STATUSLINE_COMMAND = provisionNodeLauncher(dir, 'swarm-statusline.js', 'swarm-statusline');
  HOOK_COMMAND = provisionNodeLauncher(dir, path.join('hooks', 'swarm-signal.mjs'), 'swarm-signal');
  writeSwarmSettings();
  applyAskPhrases();
}

// Append `--settings <ours>` so a launched Claude prints the context statusline.
// Only for Claude launchers (never for aider/codex/… which don't take the flag),
// and never when the command already carries an explicit --settings of its own.
function injectStatusline(cmd) {
  if (!STATUSLINE_SETTINGS || !cmd) return cmd;
  if (/(^|\s)--settings(\s|=)/.test(cmd)) return cmd;
  // First real token, skipping any leading `VAR=value` env assignments.
  const first = cmd.trim().split(/\s+/).find((t) => !/^\w+=/.test(t)) || '';
  if (!resume.supports(first)) return cmd;
  return `${cmd} --settings "${STATUSLINE_SETTINGS}"`;
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
const { extractQuestion, countSubagents, contentEnd, snapshotRows, setAskPhrases } = require('./screen');
// The status state machine + «ждёт» latch + hook arbitration live in a pure,
// unit-tested module; osc.js sniffs hook markers out of the raw pty stream.
const { tickStatus, applyHook } = require('./detector');
const { extractHookSignals } = require('./osc');

const TICK_MS = 300;
const SNAP_ROWS = 16;        // how many bottom screen rows to inspect
const RESIZE_GRACE_MS = 700; // after a resize, ignore the repaint burst as "activity"
const INPUT_GRACE_MS = 700;  // after a keystroke, ignore the echo/redraw as "activity"

/** @type {Map<string, any>} id -> detector state */
const det = new Map();

function makeDetector(cols, rows) {
  return {
    term: new HeadlessTerminal({ cols: cols || 80, rows: rows || 24, scrollback: 200, allowProposedApi: true }),
    lastDataAt: Date.now(),
    graceUntil: 0,
    status: '', detail: '', statusline: '', question: null, sub: 0, dead: false,
    // Waiting latch (fallback detection, no hooks): hold «ждёт» through screen
    // noise, release only when the agent genuinely resumed. See detector.js.
    waitLatched: false, waitKind: null, waitingKind: null, chromeGoneSince: 0,
    answeredAt: 0,             // when you last pressed Enter here (see session:input)
    // Hooks channel: once a marker arrives, hooksActive drives status; oscCarry
    // reassembles a marker split across pty chunks. See osc.js / detector.js.
    hooksActive: false, hookState: null, oscCarry: '',
    // Transcript probe (read-only, see below): the .jsonl this tab was matched to.
    cwd: '', startedAt: Date.now(),
    trFile: null, trMtime: 0, trEntries: null, trStatus: '', trWhy: '', trLogged: '',
  };
}

// Read the bottom SNAP_ROWS lines of the emulator's current screen. The window is
// anchored to the last row WITH CONTENT, not to buf.length — see screen.js for why
// (a shrinking TUI frame leaves blank rows the buffer never gives back).
function snapshot(d) {
  return snapshotRows(d.term.buffer.active, SNAP_ROWS);
}

// The user's Claude statusline (model │ dir [bar] % │ task) renders on the very
// bottom row. Grab the lowest visible line that looks like it (has the │
// separators or the progress-bar blocks) so the app can show it in a footer.
function extractStatusline(d) {
  const buf = d.term.buffer.active;
  const end = contentEnd(buf);   // same anchor as snapshot(): blank tail rows lie
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
  // Sniff invisible hook markers out of the raw stream (carry a tail so one split
  // across chunks still assembles). A signal flips this session to hook-driven.
  const { signals, rest } = extractHookSignals(d.oscCarry + chunk);
  d.oscCarry = rest;
  for (const sig of signals) applyHook(d, sig.token, Date.now());
  // A resize makes Claude repaint the whole screen — a burst of output that is
  // NOT real work. Inside the grace window after a resize we keep feeding the
  // emulator (so the screen stays correct) but don't count it as activity, so an
  // idle agent won't flash "работает" and fire a false notification.
  const now = Date.now();
  if (now >= d.graceUntil) d.lastDataAt = now;
}

setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  for (const [id, d] of det) {
    if (d.dead) continue;
    // Mid-resize the screen is repainting and unreliable: a half-drawn prompt box
    // reads as «готов» and would flip a waiting tab green until the next settled
    // tick. That's the "collapse a folder → waiting tab turns green" bug — a
    // collapse resizes the active terminal. Hold the last status through the
    // repaint burst (same grace window feedDetector uses to ignore the bytes).
    if (now < d.graceUntil) continue;
    try {
      const snap = snapshot(d);
      // Status = hooks when this session has spoken through them (arbitration:
      // hook wins, screen only upgrades a «ready» to a prose question); otherwise
      // the screen-scrape + «ждёт» latch fallback (never released by mere typing).
      const next = tickStatus(d, now, snap);
      const kind = next.status === 'waiting' ? (next.kind || null) : null;
      const statusline = extractStatusline(d);
      // How many sub-agents are running (Claude's Task/agent tool). Sent raw; the
      // renderer decides whether to keep the tab «работает» while they run and
      // whether to show the agent badge — both are toggles in the tab settings.
      const sub = countSubagents(snap);
      // Only a waiting agent has a question on screen; anything else would be
      // scraping streamed prose. null in every other state.
      const question = next.status === 'waiting' ? extractQuestion(snap) : null;
      if (next.status !== d.status || next.detail !== d.detail
          || statusline !== d.statusline || question !== d.question || sub !== d.sub
          || kind !== d.waitingKind) {
        d.status = next.status;
        d.detail = next.detail;
        d.statusline = statusline;
        d.question = question;
        d.sub = sub;
        d.waitingKind = kind;
        safeSend('session:status', { id, status: next.status, detail: next.detail, statusline, question, sub, waitingKind: kind });
      }
    } catch (_) {
      // A detector hiccup must never crash the app or freeze the UI.
    }
  }
}, TICK_MS);

// --- transcript probe: READ-ONLY experiment ----------------------------------
// Claude writes every message to ~/.claude/projects/<slug>/<session>.jsonl as it
// happens. That file can drive «работает / готов / ждёт-вопрос» with no screen
// heuristics and no hook process per tool call (see transcript.js). Before betting
// the UI on it, we run it ALONGSIDE the live detector and log where the two disagree.
// Nothing here touches d.status — the tab keeps showing what it showed before.
// Log: <userData>/transcript-probe.log.
const transcript = require('./transcript');
const TR_TICK_MS = 1000;
const TR_TAIL_BYTES = 64 * 1024;   // plenty for the last few entries of a big file

function trLogPath() { return path.join(app.getPath('userData'), 'transcript-probe.log'); }
function trLog(line) {
  try { fs.appendFileSync(trLogPath(), new Date().toISOString().slice(11, 23) + ' ' + line + '\n'); }
  catch (_) { /* the probe must never break the app */ }
}

// Last `bytes` of a file as text, dropping the first (likely partial) line.
function tailText(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

// Find this tab's transcript: in the project folder for its cwd, the most recently
// touched .jsonl that (a) was written since the tab opened, (b) isn't already taken
// by another tab, and (c) records the SAME cwd inside — the folder name is a guess,
// the recorded cwd is proof. Returns null until claude actually starts writing.
function claimTranscript(d, taken) {
  const dir = path.join(os.homedir(), '.claude', 'projects', transcript.projectSlug(d.cwd));
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { return null; }
  const cands = [];
  for (const n of names) {
    const file = path.join(dir, n);
    if (taken.has(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (st.mtimeMs < d.startedAt - 2000) continue;   // untouched since this tab opened
    cands.push({ file, mtime: st.mtimeMs });
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  for (const c of cands) {
    try {
      if (transcript.cwdOf(transcript.parseEntries(tailText(c.file, TR_TAIL_BYTES))) === d.cwd) return c.file;
    } catch (_) { /* unreadable → next candidate */ }
  }
  return null;
}

setInterval(() => {
  const now = Date.now();
  const taken = new Set();
  for (const d of det.values()) if (d.trFile) taken.add(d.trFile);
  for (const [id, d] of det) {
    if (d.dead || !d.cwd) continue;
    try {
      if (!d.trFile) {
        const file = claimTranscript(d, taken);
        if (!file) continue;
        d.trFile = file;
        taken.add(file);
        trLog(`tab=${id} matched ${path.basename(file)}`);
      }
      // Re-read only when the file actually moved, but re-CLASSIFY every tick:
      // «готов» arrives by the ready-debounce expiring, not by a new write.
      const st = fs.statSync(d.trFile);
      if (st.mtimeMs !== d.trMtime) {
        d.trMtime = st.mtimeMs;
        d.trEntries = transcript.parseEntries(tailText(d.trFile, TR_TAIL_BYTES));
      }
      const v = transcript.classify(d.trEntries || [], now, (t) => asksWith(ASK_MATCHER, t));
      d.trStatus = v ? v.status + (v.kind ? ':' + v.kind : '') : '?';
      d.trWhy = v ? v.why : 'no entries';
      const shown = d.status + (d.waitingKind ? ':' + d.waitingKind : '');
      const key = shown + ' | ' + d.trStatus;
      if (key !== d.trLogged) {
        d.trLogged = key;
        const mark = shown === d.trStatus ? 'ok  ' : 'DIFF';
        trLog(`${mark} tab=${id} экран=${shown} стенограмма=${d.trStatus} (${d.trWhy})`);
      }
    } catch (e) {
      d.trFile = null;   // file rotated / deleted → re-claim next tick
    }
  }
}, TR_TICK_MS);

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

// Diff counter + viewer for the active session's folder. Same contract as the
// rest: the renderer picks the cwd, git.js does the work, nothing throws here.
ipcMain.handle('git:diffstat', (_e, cwd) => git.gitDiffStat(cwd));
ipcMain.handle('git:difftext', (_e, cwd, path) => git.gitDiffText(cwd, path));

// Hand a file to the OS' default editor. The overlay is read-only on purpose —
// editing here would race the agents writing these same files — so this is the
// way out to a real IDE.
//
// Joins here rather than in the renderer: the renderer has no `path`, and
// cwd + '/' + rel would hand Windows a mixed-separator path.
ipcMain.handle('shell:openPath', (_e, cwd, rel) => shell.openPath(path.join(cwd, rel)));

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
  const d0 = makeDetector(opts.cols, opts.rows);
  d0.cwd = cwd;                       // the transcript probe matches files by cwd
  det.set(id, d0);

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
  const cmd = injectStatusline(opts.command != null ? opts.command : START_COMMAND);
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
  if (!d) return;
  const now = Date.now();
  if (/[\r\n]/.test(String(data || ''))) {
    // Enter: you SENT something. Don't sit out the grace window — that froze the
    // detector for INPUT_GRACE_MS right when the picture changes fastest, and left
    // lastDataAt stale so the agent's first output didn't read as «работает».
    // This is a hint, not a verdict: a quiz answers one question and paints the
    // next, and detector.js keeps «ждёт» whenever a prompt box is still on screen.
    d.graceUntil = 0;
    d.lastDataAt = now;
    d.answeredAt = now;
  } else {
    d.graceUntil = now + INPUT_GRACE_MS;
  }
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

// Open a URL in the user's default browser (terminal link clicks). We only hand
// http(s) to the OS — anything else (file:, javascript:, custom schemes) is
// dropped so a rogue link in pty output can't launch arbitrary handlers.
ipcMain.on('shell:openExternal', (_event, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
  } catch (_) {}
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
// Renderer pushes the «precise status via hooks» pref (on startup and on toggle).
// We rewrite swarm-settings.json; the flag is read by claude at launch, so it
// applies to sessions started after the change.
ipcMain.on('settings:hooks', (_e, enabled) => {
  HOOKS_ENABLED = !!enabled;
  try { writeSwarmSettings(); } catch (e) { reportMainError(e); }
});
// Renderer pushes the «agent is calling me» phrases (on startup and on save). Takes
// effect immediately for screen scraping; the hook picks the new file up on its next
// run, so it applies within the current session too.
ipcMain.on('settings:askPhrases', (_e, list) => {
  ASK_PHRASES = normalizePhrases(list);
  try { applyAskPhrases(); } catch (e) { reportMainError(e); }
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
  try { provisionStatusline(); } catch (e) { reportMainError(e); } // bar is best-effort
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
