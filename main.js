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

const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeImage, shell, safeStorage, powerSaveBlocker, powerMonitor } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');   // randomUUID for the pinned Claude session id

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
const { DEFAULT_ASK_PHRASES, normalizePhrases, phraseSources, buildAskMatcher, asksWith, askExcerpt } = require('./ask-phrases');
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
let ASK_MATCHER = buildAskMatcher(ASK_PHRASES);     // for the transcript reader

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

// The launcher of a command line — first real token, skipping `VAR=value` prefixes.
function launcherOf(cmd) {
  return String(cmd || '').trim().split(/\s+/).find((t) => !/^\w+=/.test(t)) || '';
}

// Append `--settings <ours>` so a launched Claude prints the context statusline.
// Only for Claude launchers (never for aider/codex/… which don't take the flag),
// and never when the command already carries an explicit --settings of its own.
function injectStatusline(cmd) {
  if (!STATUSLINE_SETTINGS || !cmd) return cmd;
  if (/(^|\s)--settings(\s|=)/.test(cmd)) return cmd;
  if (!resume.supports(launcherOf(cmd))) return cmd;
  return `${cmd} --settings "${STATUSLINE_SETTINGS}"`;
}

// Pin the session id Claude will use, so we know EXACTLY which transcript file belongs
// to this tab: ~/.claude/projects/<slug>/<id>.jsonl. Without it the file has to be
// guessed by folder + mtime, which is a coin flip once two tabs share a folder — and a
// wrong guess would show one agent's status on another agent's tab.
//
// Skipped when the command already carries a session flag (--resume / --continue /
// --session-id): then the id isn't ours to choose. Those sessions fall back to the
// hook marker (it reports session_id) or to the folder scan.
function injectSessionId(cmd) {
  if (!cmd || !resume.supports(launcherOf(cmd))) return { cmd, sessionId: null };
  if (/(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|=|$)/.test(cmd)) return { cmd, sessionId: null };
  const sessionId = crypto.randomUUID();
  return { cmd: `${cmd} --session-id ${sessionId}`, sessionId };
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
const { extractQuestion, countSubagents, contentEnd, snapshotRows, setAskPhrases, parsePrompt } = require('./screen');
// The status state machine + «ждёт» latch + hook arbitration live in a pure,
// unit-tested module; osc.js sniffs hook markers out of the raw pty stream.
const { tickStatus, applyHook, applyTranscript } = require('./detector');
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
    // Transcript channel (see the reader below): the folder this tab runs in, the
    // Claude session id we pinned at launch (or learned from a hook marker), the
    // .jsonl bound to it, and the last verdict read out of it.
    // Identity for the Telegram bridge: the tab's visible name and the key that outlives
    // the process (the forum topic hangs on it). tgTimer debounces the «ждёт» message.
    tabKey: '', name: '', tgTimer: null, tgMode: false, tgPrimed: false, trReply: '',
    tgTopicLive: false, tgTopicName: '',
    cwd: '', startedAt: Date.now(), claudeSessionId: null,
    trFile: null, trMtime: 0, trEntries: null, trState: null, trText: '', trWhy: '', trTryAt: 0,
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
  for (const sig of signals) {
    // The marker carries Claude's own session_id. Routing doesn't need it (each agent
    // has its own pty), but the transcript reader does: it's the exact file name. This
    // is how a RESUMED session — where we didn't choose the id — still binds precisely.
    if (sig.sessionId && sig.sessionId !== d.claudeSessionId) {
      d.claudeSessionId = sig.sessionId;
      // The tab's conversation changed under us (/clear, a `claude` typed by hand, a
      // /resume inside the terminal). Tell the renderer so the id it saves for the next
      // launch is the conversation you're actually in, not the one we started with.
      safeSend('session:claude', { id, claudeSessionId: sig.sessionId });
      // If this tab is already being driven from Telegram, the hook needs to know its id
      // to refuse the interactive picker — rewrite the list now that we have one.
      if (d.tgMode) tgWriteModes();
    }
    applyHook(d, sig.token, Date.now());
  }
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
      // WHAT the agent is asking. Word-for-word from Claude's own transcript when the
      // tab is bound to one (d.trText) — that text is whole even after it scrolls out
      // of the visible rows. The screen scrape stays as the fallback for a permission
      // box (which lives only on screen) and for unbound tabs.
      const question = next.status === 'waiting' ? (d.trText || extractQuestion(snap)) : null;
      if (next.status !== d.status || next.detail !== d.detail
          || statusline !== d.statusline || question !== d.question || sub !== d.sub
          || kind !== d.waitingKind) {
        const prev = d.status;
        d.status = next.status;
        d.detail = next.detail;
        d.statusline = statusline;
        d.question = question;
        d.sub = sub;
        d.waitingKind = kind;
        safeSend('session:status', { id, status: next.status, detail: next.detail, statusline, question, sub, waitingKind: kind });
        // Telegram: an agent starting to wait is the whole point of the bridge. Sent on
        // a delay (see tgOnWaiting) and cancelled if you answer at the keyboard first.
        if (next.status === 'waiting') tgOnWaiting(id);
        else tgCancelWaiting(d);
        // Turn finished on a task that came from the phone → report back there.
        if (next.status === 'ready' && prev === 'running' && TG.chatId != null
            && (d.tgMode || TG.mirrorAll || tgAway())) {
          tgNotifyDone(id, d).catch(reportMainError);
        }
      }
    } catch (_) {
      // A detector hiccup must never crash the app or freeze the UI.
    }
  }
}, TICK_MS);

// --- transcript reader: Claude's own message log ------------------------------
// Claude appends every message to ~/.claude/projects/<slug>/<session>.jsonl as it
// happens, so the file says what the agent is doing without guessing from pixels:
// an open tool_use → работает, a tool_result → думает, a quiet assistant message →
// конец хода (and the call phrase in it → ждёт-вопрос). transcript.js owns the
// classification; this block owns the file I/O and the tab↔file binding, and hands the
// verdict to the detector as its third channel (see detector.js applyTranscript).
//
// It also gives us the ONE thing the screen can't: the question word for word, whole,
// even after it scrolls out of the visible rows.
const transcript = require('./transcript');
const TR_TICK_MS = 500;
const TR_TAIL_BYTES = 64 * 1024;   // plenty for the last few entries of a big file
const TR_TEXT_MAX = 500;           // question excerpt sent to the renderer
const TR_REPLY_MAX = 3000;         // finished-turn report relayed to Telegram
const TR_BIND_EVERY_MS = 2000;     // don't rescan a folder on every tick while unbound
// A bound file this quiet, while the pty is clearly talking, means we're reading a dead
// session — /clear starts a NEW one. Long enough that a slow tool (which writes nothing
// until it returns) can't trip it.
const TR_STALE_MS = 90_000;
// Diagnostics for the first live runs: SWARM_TRANSCRIPT_LOG=1 npm start writes every
// binding and every verdict change to <userData>/transcript.log.
const TR_DEBUG = process.env.SWARM_TRANSCRIPT_LOG === '1';

function trLog(line) {
  if (!TR_DEBUG) return;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'transcript.log'),
      new Date().toISOString().slice(11, 23) + ' ' + line + '\n');
  } catch (_) { /* diagnostics must never break the app */ }
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

function projectDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', transcript.projectSlug(cwd));
}

// Bind this tab to a transcript file. Two ways, and the difference matters:
//
//   • by session id — we pinned it with --session-id at launch, or a hook marker told
//     us. Exact, no guessing.
//   • by folder scan — fallback for sessions whose id isn't ours (a resumed tab with
//     hooks off, or `claude` typed by hand). A candidate must have been written since
//     the tab opened, not be taken by another tab, and record the SAME cwd inside (the
//     folder name is a guess, the recorded cwd is proof). If TWO files still qualify we
//     bind NOTHING: showing one agent's status on another agent's tab is far worse than
//     falling back to the screen scraper.
//
// Returns null until claude actually starts writing.
function bindTranscript(d, taken) {
  const dir = projectDir(d.cwd);
  if (d.claudeSessionId) {
    const file = path.join(dir, d.claudeSessionId + '.jsonl');
    if (taken.has(file)) return null;
    return fs.existsSync(file) ? file : null;
  }
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { return null; }
  const cands = [];
  for (const n of names) {
    const file = path.join(dir, n);
    if (taken.has(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    // Read the tail only for files young enough to be ours — the cwd check costs I/O.
    if (st.mtimeMs < d.startedAt - transcript.BIND_MTIME_SLACK_MS) continue;
    let cwdInside = null;
    let text = '';
    try {
      const entries = transcript.parseEntries(tailText(file, TR_TAIL_BYTES));
      cwdInside = transcript.cwdOf(entries);
      // Kept for the tie-break below: what the agent last SAID is also on its own screen.
      text = transcript.entryText(transcript.lastMain(entries) || {});
    } catch (_) {}
    cands.push({ file, mtimeMs: st.mtimeMs, cwdInside, text });
  }
  const one = transcript.pickBinding(cands, { startedAt: d.startedAt, cwd: d.cwd, taken });
  if (one) return one;
  // Ambiguous by folder — the normal case with several tabs on one repo. Match what's on
  // THIS tab's screen against each candidate's last message.
  const same = cands.filter((c) => c.cwdInside === d.cwd && !taken.has(c.file));
  if (same.length < 2) return null;
  const byScreen = transcript.pickByScreen(same, snapshot(d));
  if (byScreen) trLog(`tab=${d.name || '?'} разведены по экрану → ${path.basename(byScreen)}`);
  return byScreen;
}

// Is there a transcript in this tab's folder that's newer than the one we're bound to?
// That's the signature of /clear: Claude started a fresh session (a new id, a new file)
// and our file will never be written again.
function newerTranscriptExists(d, taken) {
  const dir = projectDir(d.cwd);
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { return false; }
  for (const n of names) {
    const file = path.join(dir, n);
    if (file === d.trFile || taken.has(file)) continue;
    try { if (fs.statSync(file).mtimeMs > d.trMtime + 1000) return true; } catch (_) {}
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  const taken = new Set();
  for (const d of det.values()) if (d.trFile) taken.add(d.trFile);
  for (const [id, d] of det) {
    if (d.dead || !d.cwd) continue;
    try {
      // Bound to a session that's over? Drop it — including the id we pinned at
      // launch, which /clear has just made void — and let the scan (or the next hook
      // marker) find the new file. A frozen status is the worst thing this can do.
      if (d.trFile && now - d.trMtime > TR_STALE_MS && now - d.lastDataAt < 2000
          && newerTranscriptExists(d, taken)) {
        trLog(`tab=${id} стенограмма ${path.basename(d.trFile)} умолкла — перепривязка`);
        taken.delete(d.trFile);
        d.trFile = null; d.trMtime = 0; d.trEntries = null; d.trWhy = '';
        d.claudeSessionId = null;
        applyTranscript(d, null);
      }
      if (!d.trFile) {
        if (now - (d.trTryAt || 0) < TR_BIND_EVERY_MS) continue;
        d.trTryAt = now;
        const file = bindTranscript(d, taken);
        if (!file) continue;
        d.trFile = file;
        taken.add(file);
        trLog(`tab=${id} → ${path.basename(file)}${d.claudeSessionId ? ' (по session id)' : ' (сканом папки)'}`);
        // Bound without knowing the id (hooks off, `claude` typed by hand, a tab restored
        // by its old swarm-* name): the FILE NAME is that id. Hand it to the renderer so
        // the tab is saved with an exact handle and the next restore stops relying on a
        // name match. Deliberately not written into d.claudeSessionId — binding must stay
        // free to re-scan; this is only what we persist.
        if (!d.claudeSessionId) {
          safeSend('session:claude', { id, claudeSessionId: path.basename(file, '.jsonl') });
        }
      }
      // Re-read only when the file actually moved, but re-CLASSIFY every tick:
      // «готов» arrives by the ready-debounce expiring, not by a new write.
      const st = fs.statSync(d.trFile);
      if (st.mtimeMs !== d.trMtime) {
        d.trMtime = st.mtimeMs;
        d.trEntries = transcript.parseEntries(tailText(d.trFile, TR_TAIL_BYTES));
        // One message can be longer than the tail (a big tool result). Nothing parsed
        // out of a non-empty file means we cut inside a single line — read wider once.
        if (!d.trEntries.length && st.size > TR_TAIL_BYTES) {
          d.trEntries = transcript.parseEntries(tailText(d.trFile, TR_TAIL_BYTES * 8));
        }
      }
      const v = transcript.classify(d.trEntries || [], now, (t) => asksWith(ASK_MATCHER, t));
      applyTranscript(d, v);
      // The question, word for word — only for a turn that ended asking. Anything else
      // would be quoting streamed prose back at the user.
      d.trText = v && v.status === 'waiting' ? askExcerpt(ASK_MATCHER, v.text, TR_TEXT_MAX) : '';
      // The finished turn's closing message — what the Telegram bridge sends back as
      // «вот что получилось». Kept whole-ish: it's a report, not a chip label.
      if (v && v.status === 'ready') d.trReply = String(v.text || '').trim().slice(0, TR_REPLY_MAX);
      const why = v ? v.status + (v.kind ? ':' + v.kind : '') + ' (' + v.why + ')' : 'no entries';
      if (why !== d.trWhy) { d.trWhy = why; trLog(`tab=${id} ${why}`); }
    } catch (_) {
      // File rotated, deleted, or unreadable: drop the binding and fall back to the
      // screen until we can bind again.
      d.trFile = null; d.trMtime = 0; d.trEntries = null; d.trWhy = '';
      applyTranscript(d, null);
    }
  }
}, TR_TICK_MS);

// --- Telegram bridge: token, pairing, the poll loop ---------------------------
// The bot belongs to the USER: they paste a token from their own BotFather bot, so every
// install talks to its own bot and nothing goes through anyone else's server.
//
// The token is a secret, so it does NOT live in the renderer's localStorage next to the
// theme and the layout. main owns it, encrypted with the OS keychain (safeStorage), in a
// file only this account can read. The UI gets back a MASKED form and never the token
// itself — so it can't leak through a log, a devtools session or a settings export.
//
// telegram.js holds everything protocol-shaped (and is unit-tested); this block is the
// part that has to touch Electron, the disk and the sessions.
const telegram = require('./telegram');
const voice = require('./voice');
const { execFile } = require('child_process');
const qrcode = require('qrcode-generator');   // one file, no deps: the pairing QR

// How long a pairing code lives. NOT two minutes: the realistic path is «отправил код →
// бот сказал, что он не админ → пошёл в настройки группы, нашёл бота, выдал права,
// проверил, что включены темы → вернулся», and that takes longer than two minutes. A code
// that dies mid-fix looked exactly like a broken bridge, because an unknown code hits the
// «this chat isn't ours» branch and is dropped in silence.
const TG_PAIR_TTL_MS = 900_000;   // 15 minutes
// «Ты не за столом» — не по фокусу окна (окно часто так и остаётся впереди, когда человек
// ушёл), а по отсутствию любого ввода на маке. Тогда в группу идут итоги ВСЕХ ходов: это и
// есть зеркало, которого ждёшь из дороги. Вернулся за клавиатуру — снова только вопросы,
// иначе телефон жужжал бы весь рабочий день.
const TG_AWAY_S = 300;

function tgAway() {
  try { return powerMonitor.getSystemIdleTime() >= TG_AWAY_S; }
  catch (_) { return false; }
}
// Diagnostics for the bridge: SWARM_TG_LOG=1 npm start writes every incoming message and
// what we did with it to <userData>/telegram.log. Added after a pairing attempt failed
// silently and the only way to tell «не дошло» from «дошло и отброшено» was to read code.
const TG_DEBUG = process.env.SWARM_TG_LOG === '1';

function tgLog(line) {
  if (!TG_DEBUG) return;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'telegram.log'),
      new Date().toISOString().slice(11, 23) + ' ' + line + '\n');
  } catch (_) { /* diagnostics must never break the bridge */ }
}

// What we tell an agent when its input arrives from a phone. Editable in the Telegram
// panel — «покороче» is a matter of taste — and kept on one line, because it's injected
// as one line of terminal input.
const TG_PROMPT_DEFAULT = 'из Telegram — отвечай коротко, текстом на телефон: без длинных'
  + ' блоков кода и путей к файлам, без вариантов с выбором клавиатурой, вопросы задавай прозой';
let TG_PROMPT = TG_PROMPT_DEFAULT;

let TG = { token: '', chatId: null, isForum: false, topics: {} };
let tgPoller = null;
let tgBot = '';        // bot username from getMe — shown in settings, used in the link
let tgPair = null;     // { code, at } while a pairing window is open
let tgError = null;    // last error, verbatim for the settings panel

function tgPath() { return path.join(app.getPath('userData'), 'telegram.dat'); }

function tgBlank() { return { token: '', chatId: null, isForum: false, topics: {}, prompt: '', keepAwake: true, mirrorAll: false, whisperBin: '', whisperModel: '' }; }

// The last result of tgCheckChat(), so the settings panel can show «бот администратор,
// темы доступны» without re-asking Telegram on every render.
let tgCheck = null;

// Anything unreadable — no keychain access, a file copied from another machine, a
// half-written save — means «not configured». Never a crash on launch.
function tgLoad() {
  try {
    const d = JSON.parse(safeStorage.decryptString(fs.readFileSync(tgPath())));
    TG = {
      token: String(d.token || ''),
      chatId: Number.isFinite(d.chatId) ? d.chatId : null,
      isForum: !!d.isForum,
      topics: (d.topics && typeof d.topics === 'object') ? d.topics : {},
      prompt: String(d.prompt || ''),
      keepAwake: d.keepAwake !== false,
      mirrorAll: !!d.mirrorAll,
      whisperBin: String(d.whisperBin || ''),
      whisperModel: String(d.whisperModel || ''),
    };
  } catch (_) { TG = tgBlank(); }
  TG_PROMPT = TG.prompt || TG_PROMPT_DEFAULT;
}

function tgSave() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Система не даёт безопасно сохранить токен (нет доступа к keychain)');
  }
  fs.writeFileSync(tgPath(), safeStorage.encryptString(JSON.stringify(TG)), { mode: 0o600 });
}

// One call to Telegram. getUpdates holds the request open for ~25 s, so the abort timer
// must be longer than that — but finite, or a half-dead connection hangs the loop.
async function tgFetchJson(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (telegram.POLL_TIMEOUT_S + 15) * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch (_) { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally { clearTimeout(timer); }
}

// Send text to the bound chat (or to `chatId` during pairing, before one is bound).
// Splits at Telegram's 4096-char limit and returns the LAST message id — that id is what
// an answer replies to, so it's the routing key tgRemember/tgRoute hang the tabs on.
async function tgSend(opts) {
  const o = opts || {};
  const chatId = o.chatId != null ? o.chatId : TG.chatId;
  if (!TG.token || chatId == null) return null;
  let last = null;
  const parts = telegram.chunkText(o.text, telegram.MAX_TEXT);
  for (const part of parts) {
    const body = { chat_id: chatId, text: part, disable_notification: !!o.silent };
    if (o.threadId) body.message_thread_id = o.threadId;
    if (o.replyTo) body.reply_to_message_id = o.replyTo;
    // Buttons go on the LAST chunk: that's the one the answer hangs off.
    if (o.replyMarkup && part === parts[parts.length - 1]) body.reply_markup = o.replyMarkup;
    let res = await tgFetchJson(telegram.apiUrl(TG.token, 'sendMessage'), body);
    // The user deleted the topic we remembered. Don't swallow the message: forget the
    // mapping (a fresh topic gets made next time) and deliver this one to General.
    if (!res.ok && body.message_thread_id && /thread not found/i.test(
      (res.body && res.body.description) || '')) {
      tgForgetTopic(body.message_thread_id);
      delete body.message_thread_id;
      res = await tgFetchJson(telegram.apiUrl(TG.token, 'sendMessage'), body);
    }
    if (!res.ok || !res.body || res.body.ok !== true) {
      tgError = telegram.classifyError(res.status, res.body).message;
      tgPush();
      return last;
    }
    last = res.body.result && res.body.result.message_id;
  }
  return last;
}

// Бинарник whisper: путь из настроек, иначе поиск в PATH (имена и .exe — в voice.js).
function tgWhisperBin() {
  return voice.findBinary({
    configured: TG.whisperBin || '',
    pathEnv: process.env.PATH || '',
    isWin: process.platform === 'win32',
    join: path.join,
    exists: (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } },
  });
}

// Декодирование Opus живёт в рендерере: Chromium умеет это сам, поэтому ffmpeg не нужен ни
// на маке, ни на винде. Здесь только мостик «отправил байты — получил моно 16 кГц».
let tgDecodeSeq = 1;
const tgDecodeWaiting = new Map();

ipcMain.on('audio:decoded', (_e, { reqId, samples, error } = {}) => {
  const done = tgDecodeWaiting.get(reqId);
  if (!done) return;
  tgDecodeWaiting.delete(reqId);
  done(error ? { error } : { samples });
});

function tgDecodeAudio(bytes) {
  return new Promise((resolve) => {
    const reqId = tgDecodeSeq++;
    tgDecodeWaiting.set(reqId, resolve);
    safeSend('audio:decode', { reqId, bytes });
    // Окно может быть закрыто или занято — не держим голос вечно.
    setTimeout(() => {
      if (tgDecodeWaiting.delete(reqId)) resolve({ error: 'декодирование не ответило' });
    }, 20000);
  });
}

// Голосовое → текст. Возвращает { text } или { error } — текст ошибки уходит в чат как
// есть, потому что человек с телефоном должен понимать, что чинить.
async function tgVoiceToText(fileId) {
  const bin = tgWhisperBin();
  if (!bin || !TG.whisperModel) {
    return { error: 'Голос не настроен: укажи путь к whisper.cpp и модели в «Настройки → Телеграм».' };
  }
  const info = await tgFetchJson(telegram.apiUrl(TG.token, 'getFile'), { file_id: fileId });
  const fpath = info.ok && info.body && info.body.ok === true && info.body.result && info.body.result.file_path;
  if (!fpath) return { error: 'Не смог забрать файл у Telegram.' };
  const res = await fetch(`${telegram.API_HOST}/file/bot${TG.token}/${fpath}`);
  if (!res.ok) return { error: 'Не смог скачать голосовое.' };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const decoded = await tgDecodeAudio(bytes);
  if (decoded.error || !decoded.samples) return { error: 'Не смог декодировать запись: ' + (decoded.error || 'пусто') };
  const wav = path.join(os.tmpdir(), `swarm-voice-${Date.now()}.wav`);
  fs.writeFileSync(wav, voice.wavFromFloat32(decoded.samples, voice.SAMPLE_RATE));
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(bin, voice.whisperArgs({ model: TG.whisperModel, wav }),
        { timeout: 120000, maxBuffer: 4 << 20 },
        (err, stdout, stderr) => (err && !stdout ? reject(new Error(String(stderr || err.message).slice(0, 200))) : resolve(stdout)));
    });
    const text = voice.parseOutput(out);
    return text ? { text } : { error: 'Ничего не разобрал — тишина или слишком коротко.' };
  } catch (e) {
    return { error: 'whisper не отработал: ' + ((e && e.message) || e) };
  } finally {
    try { fs.unlinkSync(wav); } catch (_) {}
  }
}

function tgQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  return qr.createDataURL(6, 8);   // a GIF data URL: no canvas, no renderer work
}

// The bridge only works in a FORUM supergroup, and that's a hard requirement, not a
// preference: the swarm is many tabs at once, so «one tab = one topic» is the only shape
// where a phone can tell them apart, address them and count unread per agent. A single
// linear chat would need the user to remember who they're talking to on every message.
//
// Two of the three ways this can be misconfigured are silent, which is why we check
// instead of hoping: a non-admin bot can't create topics, and — the nasty one — Telegram's
// privacy mode means a non-admin bot in a group never even receives plain messages, only
// replies to its own. «Бот молчит» is not a diagnosis a user should have to reach alone.
async function tgCheckChat(chatId) {
  const target = chatId != null ? chatId : TG.chatId;
  if (!TG.token || target == null) return null;
  const chat = await tgFetchJson(telegram.apiUrl(TG.token, 'getChat'), { chat_id: target });
  if (!chat.ok || !chat.body || chat.body.ok !== true) {
    return { ok: false, note: telegram.classifyError(chat.status, chat.body).message };
  }
  const info = chat.body.result || {};
  const title = info.title || info.username || 'чат';
  const isForum = !!info.is_forum;
  if (info.type === 'private') {
    return { ok: false, title, isForum: false, note: 'Личный чат не подойдёт: вкладок много, и'
      + ' различать их нужно темами. Создай группу, включи в ней «Темы», добавь туда бота'
      + ' администратором — и привяжи её.' };
  }
  if (info.type !== 'supergroup' || !isForum) {
    return { ok: false, title, isForum, note: `В «${title}» не включены темы. Настройки группы →`
      + ' «Темы» → включить. Обычная группа без тем не подойдёт: каждая вкладка живёт в своей теме.' };
  }
  const me = await tgFetchJson(telegram.apiUrl(TG.token, 'getChatMember'),
    { chat_id: target, user_id: Number(String(TG.token).split(':')[0]) });
  const member = (me.ok && me.body && me.body.ok === true && me.body.result) || null;
  const status = member ? member.status : '';
  if (!member || status === 'left' || status === 'kicked') {
    return { ok: false, title, isForum, note: `Бота нет в «${title}» — добавь его в группу.` };
  }
  const admin = status === 'administrator' || status === 'creator';
  if (!admin) {
    return { ok: false, title, isForum, note: `В «${title}» бот не администратор. Без этого Телеграм`
      + ' не покажет ему обычные сообщения в темах (режим приватности) и не даст создавать темы.' };
  }
  if (member.can_manage_topics === false) {
    return { ok: false, title, isForum, note: `В «${title}» у бота нет права «Управление темами» —`
      + ' вкладки не получат своих тем. Включи это право в его админ-настройках.' };
  }
  return { ok: true, title, isForum: true, note: `«${title}»: бот администратор, темы доступны.` };
}

function tgState() {
  return {
    available: safeStorage.isEncryptionAvailable(),
    configured: !!TG.token,
    masked: telegram.maskToken(TG.token),
    bot: tgBot,
    chatId: TG.chatId,
    isForum: TG.isForum,
    live: !!(tgPoller && tgPoller.alive),
    error: tgError,
    prompt: TG_PROMPT,
    promptDefault: TG_PROMPT_DEFAULT,
    keepAwake: !!TG.keepAwake,
    mirrorAll: !!TG.mirrorAll,
    whisperBin: TG.whisperBin,
    whisperModel: TG.whisperModel,
    voiceHint: voice.setupHint(process.platform),
    voiceReady: !!(tgWhisperBin() && TG.whisperModel),
    check: tgCheck,
    pairing: tgPair ? { code: tgPair.code, until: tgPair.at + TG_PAIR_TTL_MS } : null,
  };
}

function tgPush() { safeSend('telegram:state', tgState()); }

// Hold off system sleep while a chat is bound. Only «app suspension» — the screen may
// still turn off, we just need the process to keep polling.
let tgAwakeId = null;

function tgApplyKeepAwake() {
  const want = !!(TG.keepAwake && TG.token && TG.chatId != null);
  if (want && tgAwakeId == null) {
    tgAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!want && tgAwakeId != null) {
    try { powerSaveBlocker.stop(tgAwakeId); } catch (_) {}
    tgAwakeId = null;
  }
}

function tgStop() {
  if (tgPoller) { tgPoller.stop(); tgPoller = null; }
}

// Check the token with getMe, then start polling. getMe first so a wrong token says so
// immediately in the settings panel instead of failing inside the loop.
async function tgConnect() {
  tgStop();
  tgError = null;
  if (!TG.token) { tgBot = ''; tgPush(); return; }
  let me;
  try { me = await tgFetchJson(telegram.apiUrl(TG.token, 'getMe'), {}); }
  catch (e) { tgError = 'Не дозвонились до Telegram: ' + ((e && e.message) || e); tgPush(); return; }
  if (!me.ok || !me.body || me.body.ok !== true) {
    tgError = telegram.classifyError(me.status, me.body).message;
    tgPush();
    return;
  }
  tgBot = (me.body.result && me.body.result.username) || '';
  tgPoller = telegram.createPoller({
    token: TG.token,
    fetchJson: tgFetchJson,
    onUpdate: tgOnUpdate,
    onState: (s) => {
      tgError = s && s.ok ? null : ((s && s.error && s.error.message) || null);
      if (s && s.error && s.error.fatal) tgStop();
      tgPush();
    },
  });
  tgPoller.start();
  tgApplyKeepAwake();
  tgPush();
  // Restored tabs after a relaunch: reopen/create their topics without waiting for one to
  // speak. Delayed a little so the renderer has finished restoring and naming them.
  setTimeout(() => tgEnsureTopics().catch(reportMainError), 4000);
}

// --- routing ------------------------------------------------------------------
// An answer landing in the WRONG session is the failure mode that matters here: «да,
// вариант 2» arriving in the middle of another agent's task. So there are exactly two
// ways to name a session, both explicit, and NO «last active tab» fallback:
//
//   • the forum topic the message sits in — one topic per tab;
//   • the message it replies to — we remember which session each outgoing message was
//     about.
//
// Anything else gets a hint back, not a guess.
const TG_SENT_CAP = 500;             // remembered outgoing messages (id → session)
const tgSent = new Map();            // messageId → session id
const tgTopicSession = new Map();    // threadId → session id (live sessions only)

function tgRemember(messageId, id) {
  if (!messageId) return;
  tgSent.set(messageId, id);
  while (tgSent.size > TG_SENT_CAP) tgSent.delete(tgSent.keys().next().value);
}

// Both maps are keyed by ids that belong to ONE chat, so they have to die with the mapping
// they describe. Telegram numbers topics and messages from small integers inside each
// group, so a fresh group hands out thread 2 and message 3 immediately — and a leftover
// `2 → вкладка 7` from the previous group routes the new group's first message into an
// unrelated tab. Whoever clears TG.topics clears these.
function tgResetRouting() {
  tgTopicSession.clear();
  tgSent.clear();
  // The per-tab memory of «this tab already has a live topic» belongs to the old chat too:
  // without this a tab would skip reopening/renaming its topic in the new group.
  for (const d of det.values()) { d.tgTopicLive = false; d.tgTopicName = ''; }
}

function tgTabName(id) {
  const d = det.get(id);
  return (d && d.name) || `вкладка ${id}`;
}

// The topic for this tab, created on first need. The mapping is keyed by the tab's
// persistent key (not the per-run session id), so after a relaunch the same tab keeps
// writing into the same topic instead of littering the group with new ones.
async function tgTopicFor(id) {
  const d = det.get(id);
  if (!d || !TG.isForum || TG.chatId == null) return null;
  const key = d.tabKey || '';
  if (!key) return null;
  const known = TG.topics[key];
  if (known) {
    tgTopicSession.set(known, id);
    // First use in this run: the topic may have been closed when the tab last went away.
    if (!d.tgTopicLive) {
      d.tgTopicLive = true;
      d.tgTopicName = d.name;
      tgTopicCall('reopenForumTopic', known).catch(reportMainError);
      tgRenameTopic(id);          // the tab may have been renamed while we were away
    }
    return known;
  }
  const res = await tgFetchJson(telegram.apiUrl(TG.token, 'createForumTopic'), {
    chat_id: TG.chatId,
    name: tgTabName(id).slice(0, 128),
  });
  if (!res.ok || !res.body || res.body.ok !== true) {
    // No rights to manage topics, or not a forum after all: fall back to the main chat
    // rather than going silent. Reply-routing still works there.
    tgError = telegram.classifyError(res.status, res.body).message;
    tgPush();
    return null;
  }
  const threadId = res.body.result && res.body.result.message_thread_id;
  if (!threadId) return null;
  TG.topics[key] = threadId;
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgTopicSession.set(threadId, id);
  d.tgTopicLive = true;
  d.tgTopicName = tgTabName(id);
  // Say what this topic is for, and leave a message worth replying to. An empty topic
  // gives you nothing to aim at; this line is the anchor for «пиши сюда».
  const where = d.cwd ? '\n' + d.cwd : '';
  tgRemember(await tgSend({ threadId, text: `Вкладка «${tgTabName(id)}».${where}\n\nПиши сюда — попадёт в этого агента.`, silent: true }), id);
  tgLog(`  создана тема ${threadId} для вкладки ${id}`);
  return threadId;
}

// --- topic lifecycle: the group's topic list should BE the tab list ------------
// Created on a tab's first message, renamed when you rename the tab, closed when the tab
// closes (Telegram collapses closed topics, so what's open in the group is what's open in
// the swarm), reopened if that same tab comes back after a relaunch.
function tgForgetTopic(threadId) {
  for (const [key, thread] of Object.entries(TG.topics)) {
    if (thread === threadId) delete TG.topics[key];
  }
  tgTopicSession.delete(threadId);
  try { tgSave(); } catch (e) { reportMainError(e); }
}

async function tgTopicCall(method, threadId, extra) {
  if (!TG.token || TG.chatId == null || !threadId) return;
  const body = Object.assign({ chat_id: TG.chatId, message_thread_id: threadId }, extra || {});
  // Failures here are cosmetic (a title that stayed, a topic that stayed open) — never a
  // reason to interrupt what the app was doing.
  try { await tgFetchJson(telegram.apiUrl(TG.token, method), body); } catch (_) {}
}

function tgTopicOf(d) {
  return (d && d.tabKey && TG.topics[d.tabKey]) || null;
}

// Rename the topic after the tab. Without this «claude» stays «claude» in the group after
// you've renamed the tab to «api», and the list stops matching what you see on screen.
function tgRenameTopic(id) {
  const d = det.get(id);
  const threadId = tgTopicOf(d);
  if (!threadId || !d.name || d.name === d.tgTopicName) return;
  d.tgTopicName = d.name;
  tgTopicCall('editForumTopic', threadId, { name: d.name.slice(0, 128) }).catch(reportMainError);
}

// Everything the bridge has to let go of when a tab ends, in one place BECAUSE there are
// two ways a tab ends: the shell exits on its own (onExit), or you close the tab and we
// kill it (session:kill). The kill path used to drop the detector immediately, so onExit
// found nothing to clean up and none of this ran on the ordinary close — the topic stayed
// open in the group, the tab stayed in «answering from a phone» mode, and a pending notify
// timer went on to post permission buttons for a tab that no longer exists.
//
// Idempotent: whichever path gets here first does the work, the other finds `dead` set.
function tgOnTabGone(d) {
  if (!d || d.dead) return;
  d.dead = true;
  tgCancelWaiting(d);
  tgClearMode(d);
  tgCloseTopic(d);             // the topic list mirrors the open tabs
}

// The tab is gone: say so in its topic and close it.
function tgCloseTopic(d) {
  const threadId = tgTopicOf(d);
  if (!threadId || TG.chatId == null) return;
  tgSend({ threadId, text: '⚪ вкладка закрыта', silent: true })
    .then(() => tgTopicCall('closeForumTopic', threadId))
    .catch(reportMainError);
}

// Every live tab gets its topic NOW, not when it happens to speak. A topic is the only
// address a phone has: without one you can't start a task from the group at all, and the
// group's topic list is supposed to BE the tab list — including the quiet tabs.
// Sequential on purpose: a burst of createForumTopic on a dozen tabs is exactly what
// Telegram's rate limiter is for.
let tgEnsuring = false;

async function tgEnsureTopics() {
  if (tgEnsuring || TG.chatId == null || !TG.isForum) return;
  tgEnsuring = true;
  try {
    for (const [id, d] of [...det]) {
      if (d.dead || !d.tabKey || !sessions.has(id)) continue;
      if (TG.topics[d.tabKey]) { tgTopicSession.set(TG.topics[d.tabKey], id); continue; }
      await tgTopicFor(id);
    }
  } catch (e) { reportMainError(e); } finally { tgEnsuring = false; }
}

// The decision itself is in telegram.js (and unit-tested there); main only supplies the
// live picture: which topics belong to which tabs, what we sent, and who's still alive.
function tgRoute(u) {
  const id = telegram.routeMessage(u, {
    topicSession: tgTopicSession,
    sent: tgSent,
    topics: TG.topics,
    tabs: [...det].map(([sid, d]) => ({ id: sid, tabKey: d.tabKey })),
    alive: (sid) => sessions.has(sid) && !(det.get(sid) || {}).dead,
  });
  // Cache a re-attached topic so the next message skips the scan.
  if (id != null && u && u.threadId != null) tgTopicSession.set(u.threadId, id);
  return id;
}

// Type the answer into the live pty, exactly as if it were typed at the keyboard —
// same path as the app's own input, so there's no second way into a session.
//
// Multi-line text goes in as a bracketed paste (what a terminal sends when you paste
// from the clipboard). Without it the first newline submits, so half the message went to
// the agent and the rest was typed on top as a second one. Single-line text — the common
// case — takes the plain path, so nothing new can break there.
const PASTE_ON = '\x1b[200~';
const PASTE_OFF = '\x1b[201~';

function tgAnswer(id, text) {
  const p = sessions.get(id);
  if (!p) return false;
  const body = String(text).replace(/\r\n?/g, '\n');
  p.write(body.includes('\n') ? PASTE_ON + body + PASTE_OFF + '\r' : body + '\r');
  const d = det.get(id);
  if (d) {
    d.graceUntil = 0; d.lastDataAt = Date.now(); d.answeredAt = Date.now();
    // From now on this tab is being driven from a phone: the agent gets told to answer
    // accordingly, and its finished turn is relayed back. Cleared the moment you touch
    // the keyboard here (see the session:input handler) — the mode tracks where YOU are.
    if (!d.tgMode) { d.tgMode = true; tgWriteModes(); }
  }
  return true;
}

// The set of Claude sessions currently driven from Telegram, written next to the hook
// script. The hook is a separate process, so a file is how it learns to refuse the
// interactive AskUserQuestion tool: a «choose 1/2/3» box can't be answered from a chat.
let tgModesWritten = '';

function tgWriteModes() {
  const ids = [];
  for (const d of det.values()) {
    if (d.tgMode && !d.dead && d.claudeSessionId) ids.push(d.claudeSessionId);
  }
  const body = JSON.stringify({ sessions: ids.sort() });
  if (body === tgModesWritten) return;         // nothing changed — don't touch the disk
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'swarm-tgmode.json'), body);
    tgModesWritten = body;
  } catch (e) { reportMainError(e); }
}

function tgClearMode(d) {
  if (!d || !d.tgMode) return;
  d.tgMode = false;
  d.tgPrimed = false;
  tgWriteModes();
}

// --- outbound: an agent is calling ---------------------------------------------
// Debounced: the status flips to «ждёт» a beat before the transcript reader has the
// question text, and a repaint can flicker the status for one tick. Waiting ~1s means
// one message with the real question instead of two with half of it.
const TG_NOTIFY_DELAY_MS = 1200;

function tgOnWaiting(id) {
  const d = det.get(id);
  if (!d || TG.chatId == null || !TG.token) return;
  if (d.tgTimer) return;                       // already scheduled
  d.tgTimer = setTimeout(() => {
    d.tgTimer = null;
    if (d.dead || d.status !== 'waiting') return;   // resolved at the keyboard already
    tgNotifyWaiting(id, d).catch(reportMainError);
  }, TG_NOTIFY_DELAY_MS);
}

function tgCancelWaiting(d) {
  if (d && d.tgTimer) { clearTimeout(d.tgTimer); d.tgTimer = null; }
}

// The agent finished a turn it was given from the phone: send back what it said. Only
// for tabs in Telegram mode — otherwise every turn you run at your own desk would land
// in the chat and the bridge would become a log nobody reads.
async function tgNotifyDone(id, d) {
  const text = String(d.trReply || '').trim();
  const msgId = await tgSend({
    threadId: await tgTopicFor(id),
    text: `✅ ${tgTabName(id)}${text ? '\n\n' + text : ' — готов.'}`,
  });
  // Answerable too: replying to the report continues the same session.
  tgRemember(msgId, id);
}

async function tgNotifyWaiting(id, d) {
  const permission = d.waitingKind === 'permission';
  const threadId = await tgTopicFor(id);
  // A permission is answered with BUTTONS carrying Claude's own options — never with free
  // text. You approve what you see: the request (with the command in it) is in the message,
  // and nothing that wasn't on Claude's list can be chosen. Typing «да» here still gets
  // refused, because a word is not a choice from a list.
  const prompt = permission ? parsePrompt(snapshot(d)) : null;
  if (prompt && prompt.options.length) {
    const kb = telegram.inlineKeyboard(prompt.options, String(id), prompt.fingerprint);
    if (kb) {
      const msgId = await tgSend({
        threadId,
        text: `🔐 ${tgTabName(id)} просит разрешение\n\n${prompt.title}`,
        replyMarkup: kb,
      });
      tgRemember(msgId, id);
      return;
    }
  }
  const head = permission ? '🔐 просит разрешение' : '❓ вопрос';
  const body = d.question ? '\n\n' + d.question : '';
  const tail = permission
    ? '\n\nВариантов не разобрал — ответь за компьютером.'
    : '\n\nОтветь реплаем на это сообщение.';
  const msgId = await tgSend({ threadId, text: `${head} · ${tgTabName(id)}${body}${tail}` });
  if (!permission) tgRemember(msgId, id);
}

// A tapped button. Everything is re-checked here, because a lot can happen between the
// message going out and your thumb landing on it: the tab may be gone, the prompt may have
// been answered at the keyboard, or a DIFFERENT prompt may now be on screen. Printing the
// number into that would be the worst thing this bridge could do — so the fingerprint of
// what's on screen right now must equal the one the button was built with.
async function tgOnCallback(u) {
  const ack = (text) => tgFetchJson(telegram.apiUrl(TG.token, 'answerCallbackQuery'),
    { callback_query_id: u.callbackId, text, show_alert: false }).catch(reportMainError);
  const cb = telegram.parseCallbackData(u.data);
  if (!cb) { await ack('Не понял эту кнопку.'); return; }
  const routed = tgRoute(u);
  const d = det.get(cb.tab);
  if (!d || d.dead || !sessions.has(cb.tab) || (routed != null && String(routed) !== cb.tab)) {
    await ack('Эта вкладка уже закрыта.');
    return;
  }
  const now = parsePrompt(snapshot(d));
  if (!now || now.fingerprint !== cb.fingerprint) {
    await ack('Запрос уже закрыт — на экране другое.');
    tgLog(`  нажатие мимо: отпечаток ${cb.fingerprint} ≠ ${now ? now.fingerprint : 'нет запроса'}`);
    return;
  }
  const chosen = now.options.find((o) => o.n === cb.n);
  if (!chosen) { await ack('Такого варианта здесь нет.'); return; }
  tgAnswer(cb.tab, String(cb.n));
  tgLog(`  нажатие: вкладка ${cb.tab} → вариант ${cb.n}`);
  await ack(`Выбрано: ${cb.n}. ${chosen.text}`);
  // Freeze the message: the choice is made, the buttons must not invite a second tap.
  await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'), {
    chat_id: u.chatId,
    message_id: u.messageId,
    text: `${u.text}\n\n✅ выбрано: ${cb.n}. ${chosen.text}`,
  }).catch(reportMainError);
}

// Why a pairing attempt didn't take. Told to the chat that tried, because the person
// holding the phone is the only one who can act on it.
function tgPairHint() {
  if (!tgPair) return 'Окно привязки закрыто. Открой «Настройки → Телеграм» → «Привязать чат»'
    + ' и пришли новый код.';
  const left = TG_PAIR_TTL_MS - (Date.now() - tgPair.at);
  if (left <= 0) return 'Код истёк. Нажми «Привязать чат» ещё раз и пришли новый —'
    + ' он живёт 15 минут.';
  return `Этот код не подходит. Пришли тот, что показан в настройках (действует ещё`
    + ` ${Math.ceil(left / 60000)} мин).`;
}

// Minutes a live pairing code still has, for messages that ask the user to go fix
// something and come back.
function tgPairLeftMin() {
  if (!tgPair) return 0;
  return Math.max(0, Math.ceil((TG_PAIR_TTL_MS - (Date.now() - tgPair.at)) / 60000));
}

// Bind a chat — from the pairing code or from a hand-typed id. The check is a GATE, not
// advice: binding a chat where the bot can't create topics or can't see messages would
// look like a working bridge that silently does nothing. On refusal we say exactly what to
// fix and keep the pairing window open, so the user can fix it and send the code again.
async function tgBindChat(chatId, threadId) {
  const check = await tgCheckChat(chatId);
  tgCheck = check;
  if (!check || !check.ok) {
    tgLog(`  привязка отклонена: ${(check && check.note) || 'проверка не прошла'}`);
    // Keep the window open: the user is about to go fix exactly what we just named, and a
    // code that dies while they're in the group settings is how this looked broken.
    if (tgPair) tgPair.at = Date.now();
    const note = (check && check.note) || 'Не удалось проверить чат.';
    const tail = tgPair ? ` Поправь и пришли этот же код снова — он действует ещё ${tgPairLeftMin()} мин.` : '';
    await tgSend({ chatId, threadId, text: note + tail });
    tgPush();
    return false;
  }
  TG.chatId = chatId;
  TG.isForum = true;
  TG.topics = {};
  tgResetRouting();          // ids from the previous group must not address this one
  tgPair = null;
  try { tgSave(); } catch (e) { reportMainError(e); }
  await tgSend({
    chatId,
    threadId,
    text: 'Сворм на связи. Каждая вкладка получит свою тему: пиши в тему — попадёшь в её агента.'
      + ' Список вкладок — /tabs.',
  });
  tgApplyKeepAwake();
  tgPush();
  tgEnsureTopics().catch(reportMainError);   // темы для уже открытых вкладок
  return true;
}

function tgOnUpdate(u) {
  if (!u) return;
  if (u.kind === 'callback') {
    if (TG.chatId != null && u.chatId === TG.chatId) tgOnCallback(u).catch(reportMainError);
    return;
  }
  if (u.kind !== 'message') return;
  tgLog(`← chat=${u.chatId} thread=${u.threadId == null ? '-' : u.threadId}`
    + ` reply=${u.replyToId == null ? '-' : u.replyToId} cmd=${u.command || '-'}`
    + ` text=${JSON.stringify(String(u.text || '').slice(0, 60))}`);
  // Pairing wins over everything: the chat that brings the code becomes THE chat. Until
  // then nothing is bound, so no message can be mistaken for an answer to an agent.
  if (tgPair && Date.now() - tgPair.at < TG_PAIR_TTL_MS && telegram.pairingMatch(u, tgPair.code)) {
    tgLog('  код совпал — проверяю чат');
    tgBindChat(u.chatId, u.threadId).catch(reportMainError);
    return;
  }
  // Nothing bound yet, and the code didn't match above: this is almost always someone
  // trying to pair and getting it slightly wrong (a stale code, a code from a previous
  // click, no open window at all). Silence here reads as «мост сломан», so say which of
  // those it is. Nothing can be bound by this reply, so it's safe to answer.
  if (TG.chatId == null) {
    tgLog(`  чат не привязан; код ${tgPair ? 'открыт, не совпал или истёк' : 'не запрашивали'}`);
    if (u.command === 'start' || /^[A-Za-z0-9]{4,10}$/.test(String(u.text || '').trim())) {
      tgSend({ chatId: u.chatId, threadId: u.threadId, text: tgPairHint() }).catch(reportMainError);
    }
    return;
  }
  // Anything from another chat is not ours to listen to — a stranger who found the bot
  // gets silence, not a prompt injected into somebody's session.
  if (u.chatId !== TG.chatId) { tgLog('  чужой чат — игнорирую'); return; }

  if (u.command === 'tabs') { tgSendTabs(u.threadId).catch(reportMainError); return; }
  if (u.command === 'sync') { tgSync(u.threadId).catch(reportMainError); return; }
  if (u.command === 'new') { tgNewTab(u).catch(reportMainError); return; }
  if (u.command === 'start' || u.command === 'help') {
    tgSend({ threadId: u.threadId, text: [
      'Уже на связи. Каждая вкладка живёт в своей теме — пиши в тему, попадёшь в её агента.',
      '',
      '/tabs — вкладки и что у них сейчас',
      '/sync — подтянуть темы под открытые вкладки',
      '/new — ещё один агент в папке этой темы',
    ].join('\n') }).catch(reportMainError);
    return;
  }
  if (u.voice) { tgOnVoice(u).catch(reportMainError); return; }
  const text = String(u.text || '').trim();
  if (!text) return;

  const id = tgRoute(u);
  tgLog(`  адресат: ${id == null ? 'не определён' : 'вкладка ' + id + ' (' + tgTabName(id) + ')'}`);
  if (id == null) {
    tgSend({
      threadId: u.threadId,
      replyTo: u.messageId,
      text: 'Это общая тема — здесь я не знаю, к какому агенту обращаться. Напиши в тему нужной'
        + ' вкладки (список — /tabs) или ответь реплаем на сообщение агента.',
    }).catch(reportMainError);
    return;
  }
  const d = det.get(id);
  // The one thing that never travels from a phone: approving a command. See tgNotifyWaiting.
  if (d && d.status === 'waiting' && d.waitingKind === 'permission') {
    tgSend({
      threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)} ждёт разрешения: выбери вариант кнопкой под запросом.`
        + ' Словами разрешение не даётся — одобрять можно только то, что предложил Клод.',
    }).catch(reportMainError);
    return;
  }
  // Tag the text so the agent knows it's answering into a phone (short answers, no
  // interactive pickers). The first message of a session carries the whole convention.
  const tagged = telegram.tagInput({ text, instruction: TG_PROMPT, primed: !!(d && d.tgPrimed) });
  if (!tgAnswer(id, tagged)) {
    tgSend({ threadId: u.threadId, replyTo: u.messageId, text: 'Эта вкладка уже закрыта.' }).catch(reportMainError);
    return;
  }
  if (d) d.tgPrimed = true;
  tgSend({ threadId: u.threadId, replyTo: u.messageId, text: `→ ${tgTabName(id)}`, silent: true }).catch(reportMainError);
}

// Голосовое: сначала адресат (иначе незачем и распознавать), потом эхо распознанного и
// только затем печать в сессию. Эхо обязательно: «RoseVPN» легко становится «розовым пн», и
// увидеть это надо ДО того, как агент начнёт по нему работать.
async function tgOnVoice(u) {
  const id = tgRoute(u);
  if (id == null) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: 'Не понял, какой вкладке это. Пришли голосовое в тему нужной вкладки.' });
    return;
  }
  const d = det.get(id);
  if (d && d.status === 'waiting' && d.waitingKind === 'permission') {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)} ждёт разрешения — выбери вариант кнопкой, голосом это не даётся.` });
    return;
  }
  const r = await tgVoiceToText(u.voice.fileId);
  if (r.error) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: r.error });
    return;
  }
  const tagged = telegram.tagInput({ text: r.text, instruction: TG_PROMPT, primed: !!(d && d.tgPrimed) });
  if (!tgAnswer(id, tagged)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: 'Эта вкладка уже закрыта.' });
    return;
  }
  if (d) d.tgPrimed = true;
  await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: `🎙 → ${tgTabName(id)}: ${r.text}` });
}

// /new в теме — ещё один агент в ТОЙ ЖЕ папке. Папку называть не надо: тема = вкладка =
// папка, и это самый естественный жест с телефона. Вкладки рождаются в рендерере (там
// xterm и DOM), поэтому main просит его, а не создаёт сам; тема новой вкладке создастся
// сама, как только у неё появится имя.
async function tgNewTab(u) {
  const id = tgRoute(u);
  const d = id == null ? null : det.get(id);
  if (!d || !d.cwd) {
    await tgSend({ threadId: u.threadId, text: '/new работает в теме вкладки — оттуда я знаю папку.'
      + ' Список тем — /tabs.' });
    return;
  }
  safeSend('app:createTab', { cwd: d.cwd });
  await tgSend({ threadId: u.threadId, text: `Открываю ещё одного агента в ${d.cwd}.`
    + ' Его тема появится в группе через пару секунд.' });
}

// /sync — make the group match the machine. Normally topics keep themselves in step
// (created with a tab, closed with it), but not across every accident: the app was killed
// without closing them, the group was bound before topics existed, someone deleted a
// topic by hand. This is the one command that reconciles both directions on demand.
async function tgSync(threadId) {
  if (!TG.isForum || TG.chatId == null) {
    await tgSend({ threadId, text: 'Группа не привязана.' });
    return;
  }
  await tgEnsureTopics();
  // The other direction: topics whose tab is gone. Closed, not forgotten — the mapping
  // stays so the same tab returning after a relaunch reopens its own topic.
  const live = new Set();
  for (const [id, d] of det) if (!d.dead && d.tabKey && sessions.has(id)) live.add(d.tabKey);
  let closed = 0;
  for (const [key, thread] of Object.entries(TG.topics)) {
    if (live.has(key)) continue;
    await tgTopicCall('closeForumTopic', thread);
    closed++;
  }
  const names = [...det].filter(([id, d]) => !d.dead && sessions.has(id)).map(([id]) => tgTabName(id));
  await tgSend({ threadId, text: `Тем под открытые вкладки: ${names.length}`
    + (names.length ? ' — ' + names.join(', ') : '')
    + (closed ? `\nЗакрыто тем от закрытых вкладок: ${closed}` : '') });
}

// /tabs — what every agent is doing right now, so you can orient from the phone without
// waiting for someone to call you.
async function tgSendTabs(threadId) {
  const marks = { running: '🟠 работает', waiting: '🟡 ждёт', ready: '🟢 готов' };
  const lines = [];
  for (const [id, d] of det) {
    if (d.dead) continue;
    const kind = d.status === 'waiting' && d.waitingKind ? ` (${d.waitingKind === 'permission' ? 'разрешение' : 'вопрос'})` : '';
    lines.push(`${marks[d.status] || '⚪'}${kind} · ${tgTabName(id)}`);
  }
  await tgSend({ threadId, text: lines.length ? lines.join('\n') : 'Открытых вкладок нет.' });
}

// --- IPC: the settings panel ---------------------------------------------------
ipcMain.handle('telegram:state', () => tgState());

ipcMain.handle('telegram:setToken', async (_e, raw) => {
  const token = String(raw == null ? '' : raw).trim();
  if (!telegram.looksLikeToken(token)) {
    tgError = 'Это не похоже на токен: нужен вид 1234567890:AA… из BotFather';
    return tgState();
  }
  TG = Object.assign(tgBlank(), { token });   // a new token means a new bot: unbind
  tgResetRouting();                           // …and its chat's thread/message ids
  try { tgSave(); } catch (e) { tgError = String(e.message || e); return tgState(); }
  await tgConnect();
  return tgState();
});

ipcMain.handle('telegram:forget', async () => {
  tgStop();
  TG = tgBlank();
  tgResetRouting();
  tgBot = ''; tgPair = null; tgError = null; tgCheck = null;
  try { fs.unlinkSync(tgPath()); } catch (_) { /* already gone */ }
  tgApplyKeepAwake();
  return tgState();
});

// Re-run the rights check on demand: the usual fix is «сделать бота админом», and the
// user needs a way to confirm it took without restarting anything.
ipcMain.handle('telegram:check', async () => {
  tgCheck = await tgCheckChat();
  try { tgSave(); } catch (e) { reportMainError(e); }   // isForum may have changed
  return tgState();
});

// The «you're answering from a phone» instruction (Telegram panel). Empty → the default.
ipcMain.handle('telegram:setPrompt', (_e, raw) => {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 400);
  TG.prompt = text;
  TG_PROMPT = text || TG_PROMPT_DEFAULT;
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

// Keep the Mac awake while the bridge is on: with the lid closed nothing polls, so the
// «answer from the taxi» case quietly stops working. Off = normal sleep behaviour.
// Зеркалить итоги всегда, а не только когда тебя нет за маком.
ipcMain.handle('telegram:setMirrorAll', (_e, on) => {
  TG.mirrorAll = !!on;
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

// Пути к whisper.cpp и модели. Пусто в поле бинарника = искать в PATH.
ipcMain.handle('telegram:setWhisper', (_e, { bin, model } = {}) => {
  TG.whisperBin = String(bin || '').trim();
  TG.whisperModel = String(model || '').trim();
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

ipcMain.handle('telegram:setKeepAwake', (_e, on) => {
  TG.keepAwake = !!on;
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgApplyKeepAwake();
  return tgState();
});

ipcMain.handle('telegram:unpair', async () => {
  TG.chatId = null; TG.isForum = false; TG.topics = {}; tgCheck = null;
  tgResetRouting();
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgApplyKeepAwake();
  return tgState();
});

// Open a pairing window and hand back the code, the deep links and a QR of the private
// one. crypto.randomInt, not Math.random: this code is the only thing standing between
// a stranger who found the bot and a chat bound to your machine.
ipcMain.handle('telegram:pair', () => {
  if (!TG.token || !tgBot) return { error: 'Сначала подключи бота' };
  tgPair = { code: telegram.pairCode((n) => crypto.randomInt(n)), at: Date.now() };
  // The QR carries the ?startgroup= link, because a group is the only thing we bind to:
  // scanning it offers to add the bot to a group and delivers the code from there.
  const groupLink = telegram.deepLink(tgBot, tgPair.code, { group: true });
  const state = tgState();
  tgPush();
  return {
    code: tgPair.code,
    link: groupLink,
    qr: tgQr(groupLink),
    ttlMs: TG_PAIR_TTL_MS,
    state,
  };
});

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
  d0.cwd = cwd;                       // the transcript lives under a slug of this path
  d0.tabKey = String(opts.tabKey || '');   // survives relaunch: the Telegram topic key
  d0.name = String(opts.name || '');
  det.set(id, d0);

  child.onData((data) => {
    feedDetector(id, data);
    safeSend('session:data', { id, data });
  });

  child.onExit(({ exitCode }) => {
    tgOnTabGone(det.get(id));
    sessions.delete(id);
    safeSend('session:exit', { id, code: exitCode });
  });

  // Give the login shell a moment to finish sourcing the profile, then run claude.
  const pinned = injectSessionId(injectStatusline(opts.command != null ? opts.command : START_COMMAND));
  const cmd = pinned.cmd;
  // Known id => exact transcript binding. Either we pinned it just now (a fresh tab),
  // or the renderer is restoring a conversation and told us the id it is resuming —
  // `--resume <id>` keeps that id, so the tab binds precisely from the first tick
  // instead of guessing by folder + mtime.
  d0.claudeSessionId = pinned.sessionId || String(opts.resumeId || '') || null;
  if (cmd) {
    setTimeout(() => {
      const p = sessions.get(id);
      if (p) p.write(cmd + '\r');
    }, 350);
  }

  // The renderer keeps claudeSessionId with the tab and saves it: that id is what the
  // NEXT launch resumes. Null for non-Claude tabs and clean terminals.
  return { id, cwd, claudeSessionId: d0.claudeSessionId };
});

// Is this conversation still on disk? Asked before a restored tab runs `--resume <id>`:
// a dead id would drop the tab into Claude's interactive picker (or an error) instead of
// a working agent, so we'd rather start it fresh.
//
// The folder slug is a guess (see transcript.projectSlug), so a miss falls back to a
// scan of ~/.claude/projects — the file NAME is the session id and is unique, whatever
// folder Claude filed it under.
ipcMain.handle('session:canResume', (_e, cwd, sessionId) => {
  const id = String(sessionId || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return false;
  const file = id + '.jsonl';
  try {
    if (cwd && fs.existsSync(path.join(projectDir(cwd), file))) return true;
    const root = path.join(os.homedir(), '.claude', 'projects');
    for (const dir of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, dir, file))) return true;
    }
  } catch (_) {}
  return false;
});

// --- IPC: keystrokes from the xterm in the renderer --------------------------
ipcMain.on('session:input', (_event, { id, data }) => {
  const p = sessions.get(id);
  if (p) p.write(data);
  // Your keystrokes echo back + redraw the input box — that's you typing, not the
  // agent working. Grace it so it isn't counted as activity.
  const d = det.get(id);
  if (!d) return;
  // You're at the keyboard for this tab, so it is no longer «driven from the phone»:
  // full-size answers and interactive pickers are useful again. The mode follows where
  // YOU are, not where the last message came from.
  tgClearMode(d);
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
  // BEFORE the detector goes away: the Telegram side needs it to know which topic to close
  // and which timer to cancel. Dropping it first is why closing a tab left its topic open.
  tgOnTabGone(det.get(id));
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
// The tab's visible name (create + rename). Used to title its Telegram topic and to sign
// its messages, so «→ api» in the chat means the tab you call api.
ipcMain.on('tabs:name', (_e, { id, name } = {}) => {
  const d = det.get(String(id));
  if (!d) return;
  d.name = String(name || '');
  // No topic yet (a new tab, or one restored after a relaunch) → make it now, so you can
  // write to this tab from the phone before it ever speaks. Already has one → a rename,
  // so move the topic's title along with it.
  if (!tgTopicOf(d)) tgEnsureTopics().catch(reportMainError);
  else tgRenameTopic(String(id));
});

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
  // Telegram: pick up a saved token and start polling. Best-effort like the statusline —
  // no bot, or no network, must never hold up the window.
  try { tgLoad(); tgConnect().catch(reportMainError); } catch (e) { reportMainError(e); }
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
