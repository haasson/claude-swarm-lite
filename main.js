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

const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeImage, shell, safeStorage, powerSaveBlocker } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');   // randomUUID for the pinned Claude session id

// --- ОДНА КОПИЯ НА МАШИНУ -----------------------------------------------------
// Второй сворм — это не «ещё один пульт», а тихая порча первого, потому что профиль у них
// один, и на двух писателей он не рассчитан:
//
//   • у бота Telegram может быть ТОЛЬКО ОДИН читатель. Две копии зовут getUpdates, Telegram
//     отвечает одной из них 409, и её мост гаснет насовсем (так и надо — повторы 409 не
//     лечат, см. telegram.js);
//   • список «эта вкладка отвечает в телегу» (swarm-tgmode.json) каждая копия пишет ЦЕЛИКОМ
//     из своих вкладок, то есть затирает чужой. Его читает хук, чтобы отказывать агенту в
//     интерактивном выборе «1/2/3» — затёрли, и агент снова рисует выбор в терминале, куда
//     никто не смотрит, а в телегу уходит вопрос, на который нельзя ответить;
//   • правило «один разговор Клода — одна вкладка» держится множеством внутри процесса. У
//     второй копии оно своё, поэтому две вкладки могут сесть на один файл и показывать статус
//     чужого агента;
//   • журнал моста дописывают и переливают обе копии, каждая по своему счёту размера.
//
// Плюс сохранённый список вкладок один: вторая копия поднимет тех же агентов в тех же папках.
//
// `return` в CommonJS-модуле законен (модуль обёрнут в функцию) и здесь важен: без него ниже
// продолжила бы исполняться регистрация обработчиков и создание окна, пока app.quit() ещё
// только собирается закрываться.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Приложение зовётся Swarm, а внутренние идентификаторы остались от прежнего имени —
// `name: claude-swarm-lite` в package.json и appId `io.swarm.claude-swarm-lite`. Это не
// недоделанное переименование, а условие сохранности данных, и менять их нельзя:
//
//   • `name` задаёт и папку настроек (~/Library/Application Support/claude-swarm-lite),
//     и — что важнее — имя ключа в связке ключей, которым safeStorage шифрует
//     telegram.dat. Ключ ищется по имени приложения, поэтому под новым именем он просто
//     не найдётся: файл с токеном останется, а расшифровать его будет нечем никогда.
//     Папку перенести можно, ключ — нет.
//   • appId — то, по чему установщик Windows узнаёт прежнюю установку. Новый appId даёт
//     вторую запись в «Установленных программах» вместо обновления.
//
// Пользователь ни того, ни другого не видит, так что цена нулевая. Маркеры
// `<!-- claude-swarm-lite:begin -->` в agent-rules.js оставлены по той же причине: они
// очерчивают блок, уже вставленный в чужие CLAUDE.md.
//
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
  applicationName: 'Swarm',
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
const { systemPromptRule } = require('./agent-rules');
// Keeps our own flags from filling a fresh tab's screen: long values go through the
// shell's environment, and a `clear` wipes the typed line. See launch-line.js.
const { envPassing, clearPrefix } = require('./launch-line');
const statusline = require('./swarm-statusline');   // числа расхода + текст для /usage
let STATUSLINE_COMMAND = null; // the provisioned statusline launcher command
let HOOK_COMMAND = null;       // the provisioned hook launcher command
// Opt-in: precise status via Claude hooks. Off by default; the renderer pushes the
// user's saved pref on startup (settings:hooks) and rewrites swarm-settings.json.
// Scoped to swarm sessions via --settings — never the user's global config.
let HOOKS_ENABLED = false;
// «Просить агента звать вас» — the launch-time rule (agent-rules.js) that teaches the
// agent to ask through AskUserQuestion and to sign a prose question off with the
// phrase. ON by default, unlike the hooks: without it the «ждёт ответа» status only
// works for users who already have the convention in their own CLAUDE.md, and asking
// every new user to set that up by hand is exactly what this replaces. Like the
// statusline it's scoped to swarm launches and writes nothing into the user's config.
let AGENT_RULES = true;
// «Вкладки стартуют в режиме» — режим разрешений, с которым запускается вкладка, и новая, и
// восстановленная (иначе перезапуск молча возвращал бы всех в «спрашивать разрешение»).
// Пусто = не вмешиваемся, вкладка начинает как Claude Code сам считает нужным — это и есть
// умолчание: подсовывать всем режим, о котором они не просили, нельзя, цена у режимов разная.
// Это ПЕРВЫЙ режим, а не запертый: Shift+Tab за клавиатурой и кнопки из телеги работают
// дальше как обычно.
let PERMISSION_MODE = '';

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
  pruneUsage();
}

// --- «сколько израсходовано»: снимки от статуслайна ---------------------------
// Статуслайн кладёт рядом с собой числа по сессии (swarm-statusline.js usageSnapshot):
// заполнение контекста и расход двух окон подписки. Читаем их для /usage, а не парсим
// строку с экрана — в строке числа округлены, отсчёт до сброса скрыт, пока окно не
// поджало, и самой строки не видно, когда вкладка не на экране.
function usageFile(sessionId) {
  const s = String(sessionId || '');
  if (!s || /[/\\]|\.\./.test(s)) return null;
  return path.join(app.getPath('userData'), statusline.USAGE_DIR, s + '.json');
}

function readUsage(sessionId) {
  const file = usageFile(sessionId);
  if (!file) return null;
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    return snap && typeof snap === 'object' ? snap : null;
  } catch (_) { return null; }   // нет файла — вкладка ещё не отрисовала статуслайн
}

// Снимки закрытых разговоров иначе копятся навсегда: каждая вкладка — новый id, а
// /clear и перезапуски рождают их каждый день. Неделя — с запасом больше окна 7д,
// то есть дольше, чем эти числа вообще о чём-то говорят.
const USAGE_TTL_MS = 7 * 24 * 3600 * 1000;

function pruneUsage() {
  try {
    const dir = path.join(app.getPath('userData'), statusline.USAGE_DIR);
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > USAGE_TTL_MS) fs.unlinkSync(p);
      } catch (_) { /* исчез сам — тем лучше */ }
    }
  } catch (_) { /* папки ещё нет */ }
}

// The launcher of a command line — first real token, skipping `VAR=value` prefixes.
function launcherOf(cmd) {
  return String(cmd || '').trim().split(/\s+/).find((t) => !/^\w+=/.test(t)) || '';
}

// Append `--settings <ours>` so a launched Claude prints the context statusline.
// Only for Claude launchers (never for aider/codex/… which don't take the flag),
// and never when the command already carries an explicit --settings of its own.
function injectStatusline(cmd, pass) {
  if (!STATUSLINE_SETTINGS || !cmd) return cmd;
  if (/(^|\s)--settings(\s|=)/.test(cmd)) return cmd;
  if (!resume.supports(launcherOf(cmd))) return cmd;
  return `${cmd} --settings ${pass.ref('SWARM_SETTINGS', STATUSLINE_SETTINGS)}`;
}

// Append `--append-system-prompt "<rule>"` so the agent knows how to call the user
// (see agent-rules.js). Same guards as the statusline: Claude launchers only, and we
// keep out of the way of a user who set a system prompt themselves — theirs wins,
// silently overriding it would be worse than losing the status hint. The flag is
// spelled inline rather than via --append-system-prompt-file because it has been in
// Claude Code far longer, and an unknown flag doesn't degrade — claude refuses to
// start and the tab is dead. The text itself travels in the environment (envPassing),
// which is what keeps this flag from filling the screen.
function injectAgentRules(cmd, pass) {
  if (!AGENT_RULES || !cmd) return cmd;
  if (/(^|\s)--(append-)?system-prompt(-file)?(\s|=)/.test(cmd)) return cmd;
  if (!resume.supports(launcherOf(cmd))) return cmd;
  return `${cmd} --append-system-prompt ${pass.ref('SWARM_ASK_RULE', systemPromptRule(ASK_PHRASES))}`;
}

// Append `--permission-mode <mode>` so a new tab starts in the mode the user picked
// (Настройки → Запуск). Смысл: «разреши уже всё» — самое частое, что делают руками сразу
// после открытия вкладки, а из телеги это вообще единственный способ, потому что Shift+Tab
// с телефона не нажать.
//
// Те же три оговорки, что у соседей: только лончеры Claude, и СВОЙ `--permission-mode` во
// флажках побеждает — человек, написавший флаг руками, знает, чего хочет. Плюс проверка
// самого значения: неизвестный режим claude не проглатывает, а отказывается стартовать, и
// вкладка встречает человека мёртвой оболочкой вместо агента. Лучше запустить без флага.
function injectPermissionMode(cmd) {
  if (!PERMISSION_MODE || !cmd) return cmd;
  const flag = modeFlag(PERMISSION_MODE);
  if (!flag) return cmd;
  if (/(^|\s)--permission-mode(\s|=)/.test(cmd)) return cmd;
  if (/(^|\s)--dangerously-skip-permissions(\s|$)/.test(cmd)) return cmd;
  if (!resume.supports(launcherOf(cmd))) return cmd;
  return `${cmd} --permission-mode ${flag}`;
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
const { extractQuestion, lastAgentBlock, readMode, modeTitle, modeFlag, countSubagents, contentEnd, snapshotRows, snapshotWrapped, setAskPhrases, askFingerprint, parsePrompt, scrolledBack } = require('./screen');
// The status state machine + «ждёт» latch + hook arbitration live in a pure,
// unit-tested module; osc.js sniffs hook markers out of the raw pty stream.
const { tickStatus, applyHook, applyTranscript, keyboardEvent } = require('./detector');
const { extractHookSignals } = require('./osc');

const TICK_MS = 300;
const SNAP_ROWS = 16;        // how many bottom screen rows to inspect
// Окно для ОТВЕТА, а не для статуса. Статусу хватает мебели под текстом, а ответ агента —
// это абзацы, и в шестнадцать строк он не влезает: в телегу уезжал хвост сообщения. Больше
// scrollback эмулятора (200) брать всё равно нечего.
const REPLY_ROWS = 200;
// Окно поиска плашки «вернуться вниз» (см. screen.scrolledBack). Шире, чем SNAP_ROWS:
// плашка ложится по нижней кромке вида переписки, а под ней ещё поле ввода с подсказками,
// и в шестнадцать строк она не попадает, стоит человеку набрать многострочный запрос.
const SCROLL_HINT_ROWS = 40;
const RESIZE_GRACE_MS = 700; // after a resize, ignore the repaint burst as "activity"
const INPUT_GRACE_MS = 700;  // after a keystroke, ignore the echo/redraw as "activity"

/** @type {Map<string, any>} id -> detector state */
const det = new Map();

function makeDetector(cols, rows) {
  return {
    term: new HeadlessTerminal({ cols: cols || 80, rows: rows || 24, scrollback: 200, allowProposedApi: true }),
    lastDataAt: Date.now(),
    graceUntil: 0,
    // Экран отлистан назад (человек читает историю внутри Клода) и последний снимок,
    // сделанный, пока вид был живым. Пока отлистано, ВСЕ читатели экрана получают этот
    // снимок, а байты перерисовки не считаются работой. См. snapshot() ниже.
    scrolledBack: false, liveSnap: '',
    status: '', detail: '', statusline: '', question: null, sub: 0, dead: false,
    // Waiting latch (fallback detection, no hooks): hold «ждёт» through screen
    // noise, release only when the agent genuinely resumed. See detector.js.
    waitLatched: false, waitKind: null, waitingKind: null, chromeGoneSince: 0,
    answeredAt: 0,             // when you last pressed Enter here (see session:input)
    // Отпечаток зова прозой, на который ты ответил этим Enter. Строка «Сейчас от тебя: …»
    // остаётся на экране и после ответа, и без этой отметки вкладка снова поднимала «ждёт» —
    // см. detector.asksNow.
    askAnswered: '',
    // Hooks channel: once a marker arrives, hooksActive drives status; oscCarry
    // reassembles a marker split across pty chunks. See osc.js / detector.js.
    hooksActive: false, hookState: null, oscCarry: '',
    // Transcript channel (see the reader below): the folder this tab runs in, the
    // Claude session id we pinned at launch (or learned from a hook marker), the
    // .jsonl bound to it, and the last verdict read out of it.
    // Identity for the Telegram bridge: the tab's visible name and the key that outlives
    // the process (the forum topic hangs on it). tgTimer debounces the «ждёт» message.
    // tgNotifiedAt — про это ожидание УЖЕ написали (ставится до отправки, снимается при
    // неудаче и когда вкладка перестала ждать): без этой отметки одно и то же разрешение
    // приходило дважды. tgAck — сообщение «получил, думаю…», которое станет ответом. mode —
    // последний увиденный режим разрешений: на экране его строка есть не всегда.
    tabKey: '', name: '', tgTimer: null, tgMode: false, tgPrimed: false, trReply: '',
    tgNotifiedAt: 0, tgAck: null, tgLastSent: '', trFinal: '', mode: null,
    tgTopicLive: false, tgTopicName: '',
    // Отказы отправки уведомления: сколько подряд и когда пробовать снова. Без откола такт
    // (300 мс) долбил Telegram каждые полторы секунды всё время, пока вкладка ждёт.
    tgFails: 0, tgRetryAt: 0,
    // Итог хода: когда ход начался и на какой момент у нас есть его текст из стенограммы.
    // Второе сравнивается с первым — иначе в чат уезжает ответ на ПРОШЛУЮ задачу (см.
    // tgOnDone: с хуками статус «готов» приходит раньше, чем стенограмма догоняет).
    turnStartedAt: 0, trReplyAt: 0, tgDoneTimer: null,
    // Что мост про эту вкладку уже доложил (запись стенограммы или сам текст). Тот же итог
    // второй раз — шум: см. tgNotifyDone.
    tgSentKey: '',
    // Печатал ли человек в эту вкладку с последнего Enter. «Вернулся за компьютер» — это
    // отправленное сообщение, а не любое шевеление: см. session:input.
    typedAtKeyboard: false,
    cwd: '', startedAt: Date.now(), claudeSessionId: null,
    trFile: null, trMtime: 0, trEntries: null, trState: null, trText: '', trWhy: '', trTryAt: 0,
  };
}

// Read the bottom SNAP_ROWS lines of the emulator's current screen. The window is
// anchored to the last row WITH CONTENT, not to buf.length — see screen.js for why
// (a shrinking TUI frame leaves blank rows the buffer never gives back).
//
// И ещё это ЕДИНСТВЕННАЯ дверь к экрану для всех, кто его читает, — поэтому здесь же
// живёт защита от прокрутки. Колесо уходит агенту, тот листает свой вид и рисует на
// экране прошлую переписку; отлистанный экран — не «что происходит сейчас», а чтение
// истории. Пока плашка возврата вниз на экране, отдаём последний ЖИВОЙ снимок: и
// статус, и вопрос, и разрешения, и отпечатки — всё видит вкладку такой, какой она
// была в момент, когда человек полез в историю. Само собой отпускается, как только он
// вернулся вниз и Клод убрал плашку. См. screen.scrolledBack.
function snapshot(d) {
  const buf = d.term.buffer.active;
  d.scrolledBack = scrolledBack(snapshotRows(buf, SCROLL_HINT_ROWS));
  const live = snapshotRows(buf, SNAP_ROWS);
  if (d.scrolledBack) return d.liveSnap || live;
  d.liveSnap = live;
  return live;
}

// Ты ответил в эту вкладку (за клавиатурой или с телефона — путь один, см. tgAnswer).
//
// Кроме времени запоминаем ОТПЕЧАТОК зова прозой, который сейчас на экране: диалог разрешения
// Claude Code стирает сам, а строка «Сейчас от тебя: …» остаётся висеть, и без этой отметки
// вкладка через пару секунд снова читала её как просьбу — со всеми последствиями вплоть до
// уведомления о зове, на который ты только что ответил. См. detector.asksNow.
function markAnswered(d, now) {
  d.graceUntil = 0;
  d.lastDataAt = now;
  d.answeredAt = now;
  try { d.askAnswered = askFingerprint(snapshot(d)); } catch (_) { d.askAnswered = ''; }
}

// То же, но настолько высоко, насколько помнит эмулятор, и с СКЛЕЕННЫМИ переносами: из
// этого окна берётся ТЕКСТ ответа, когда стенограммы нет (см. lastAgentBlock). Ширина окна
// терминала — свойство того, кто смотрит; в ответе, который читают с телефона, её быть не
// должно (см. snapshotWrapped).
function replySnapshot(d) {
  return snapshotWrapped(d.term.buffer.active, REPLY_ROWS);
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
  //
  // Прокрутка — та же история: пока человек листает историю внутри Клода, тот
  // перерисовывает вид на каждый щелчок колеса. Это чтение, а не работа агента, и
  // считать эти байты активностью значит красить спокойную вкладку в «работает» под
  // мышью. Пока экран отлистан, поток не двигает lastDataAt вообще — статус вкладки
  // держится на снимке, сделанном до прокрутки (см. snapshot), и на хуках, которым
  // экран не нужен.
  const now = Date.now();
  if (now >= d.graceUntil && !d.scrolledBack) d.lastDataAt = now;
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
      // Режим разрешений помним: на экране его строка есть не всегда (при открытом запросе
      // её нет вовсе), а /mode должен отвечать «какой сейчас» и в этот момент тоже.
      const mode = readMode(snap);
      if (mode) d.mode = mode;
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
        // Ход НАЧАЛСЯ. Запоминаем момент, чтобы потом отличить свежий текст хода от текста
        // прошлого — см. tgOnDone, это и есть защита от «ответил не на то, что просили».
        if (next.status === 'running' && prev !== 'running') d.turnStartedAt = now;
        // Turn finished on a task that came from the phone → report back there.
        //
        // `d.tgAck` — ДОЛГ: в чате висит «получил, думаю…», то есть человек с телефона ждёт
        // ответа именно на свой вопрос. Такой долг платится всегда, что бы за маком ни делали:
        // раньше достаточно было напечатать в этой вкладке что угодно, режим снимался, и итог
        // никуда не уезжал — заготовка оставалась с часиками навсегда, а спросивший так и не
        // узнавал, что ему ответили. Спросил из телеги — получи ответ в телегу.
        const owed = !!d.tgAck;
        const relay = next.status === 'ready' && prev === 'running' && TG.chatId != null
          && (owed || d.tgMode || tgMirrors());
        // В журнал — КАЖДАЯ смена статуса вкладки, за которой следит телеграм, и решение
        // про итог. Без этого «в телегу ничего не пришло» неотличимо от «ход не считался
        // законченным»: журнал показывал входящее сообщение и обрывался, а дальше начинались
        // догадки. Пишем и причину отказа, а не только факт.
        //
        // И `relay` в условии: пока его не было, отчёт «человека нет за маком» уходил вообще
        // без строки о переходе — в журнале итог появлялся из ниоткуда. Именно на этом
        // застрял разбор «молчащая вкладка присылает одно и то же раз в полчаса»: не видно
        // было, СЧИТАЕТ ли приложение, что там был ход.
        if (TG.chatId != null && (owed || d.tgMode || tgMirrors() || relay)) {
          tgLog(`  вкладка ${id}: ${prev} → ${next.status}${kind ? ':' + kind : ''}`
            + ` · итог ${relay ? 'отправляю' : 'нет'}`
            + (relay ? '' : ` (нужен переход работает→готов; долг=${owed ? 'да' : 'нет'}`
              + `, режим тлг=${d.tgMode ? 'да' : 'нет'}`
              + `, зеркало=${TG.mirrorAll ? 'да' : 'нет'}, где я=${tgPresence})`));
        }
        if (relay) tgOnDone(id, d);
      }
      // Уведомление могло не уйти — сеть рвётся ровно тогда, когда мак уснул или сменил
      // вайфай. Пока вкладка ждёт, а отправка не удалась, пробуем снова: потерянный запрос
      // разрешения это тишина в телеге, а человек ждёт именно его. Дребезг гасит tgOnWaiting,
      // а частоту — откол (tgRetryAt): без него это был поток отказов раз в полторы секунды,
      // который к тому же перелистывал журнал моста и стирал собственную диагностику.
      if (d.status === 'waiting' && !d.tgNotifiedAt && TG.chatId != null && !d.tgTimer
          && now >= (d.tgRetryAt || 0)) {
        tgOnWaiting(id);
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
// Предела длины ответа здесь НЕТ, и это осознанно. Настройка подробности («кратко» /
// «полностью») — это просьба к агенту отвечать короче, а не ножницы по готовому тексту:
// обрезать то, что агент уже сказал, значит прислать оборванную мысль и молча решить за
// человека, какая часть ответа ему не нужна. Длинное сообщение Telegram примет частями
// (telegram.chunkText делит по абзацам, tgSend отправляет все).
//
// Естественная граница всё равно есть: TR_TAIL_BYTES — сколько хвоста стенограммы читаем.
// Ход длиннее этого окна попадёт в чат не целиком, но такой ход не бывает ответом, он
// бывает историей с гигантскими выводами инструментов.
const TR_BIND_EVERY_MS = 2000;     // don't rescan a folder on every tick while unbound
// A bound file this quiet, while the pty is clearly talking, means we're reading a dead
// session — /clear starts a NEW one. Long enough that a slow tool (which writes nothing
// until it returns) can't trip it.
const TR_STALE_MS = 90_000;
// Журнал канала стенограммы: привязки и смены вердикта в <userData>/transcript.log. Как и
// журнал моста, пишется ВСЕГДА и ограничен по размеру. Он был за переменной окружения
// SWARM_TRANSCRIPT_LOG — и когда понадобился (в телегу уезжало «✅ готов» без текста
// ответа, потому что вкладка не привязана), его не оказалось, а включить у запущенного
// приложения нельзя. Дважды одна и та же ошибка — уже привычка, поэтому здесь тоже всегда.
const TR_LOG_MAX = 512 * 1024;

function trLog(line) {
  try {
    const file = path.join(app.getPath('userData'), 'transcript.log');
    try {
      if (fs.statSync(file).size > TR_LOG_MAX) fs.renameSync(file, file + '.1');
    } catch (_) { /* файла ещё нет */ }
    fs.appendFileSync(file, new Date().toISOString().slice(11, 23) + ' ' + line + '\n');
  } catch (_) { /* diagnostics must never break the app */ }
}

// Отвязаться от файла — ОДНОЙ функцией, вместе с текстами, которые из него взяты. Раньше
// сброс перечислялся в трёх местах и везде забывал trReply/trFinal: вкладка теряла свой файл
// (/clear, ротация, форк от --resume), а тексты прошлого хода оставались жить — и уезжали в
// чат как итог нового. Худший вид ошибки: правдоподобный ответ не на ту задачу, да ещё с
// пометкой «стенограмма» в журнале, то есть с уверенно неверной причиной.
function trForget(d) {
  d.trFile = null; d.trMtime = 0; d.trEntries = null; d.trWhy = '';
  d.trReply = ''; d.trFinal = ''; d.trText = ''; d.trReplyAt = 0;
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
// Сколько ждём файл с ПРИКРЕПЛЁННЫМ id, прежде чем признать, что разговор идёт под другим
// именем. Секунды: Claude пишет первую запись сразу, как только ему что-то сказали.
const TR_PIN_GRACE_MS = 15_000;

function bindTranscript(d, taken) {
  const dir = projectDir(d.cwd);
  if (d.claudeSessionId) {
    const file = path.join(dir, d.claudeSessionId + '.jsonl');
    if (!taken.has(file) && fs.existsSync(file)) return file;
    // Файла с этим именем нет — и раньше здесь стоял return null, то есть вкладка
    // оставалась без стенограммы НАВСЕГДА. А id — подсказка, не контракт: `--resume`
    // форкает разговор в новый файл, `/clear` начинает новый, `claude` из терминала
    // берёт свой. Наружу это выглядело так: в телегу уезжает «✅ готов» без единого
    // слова ответа, потому что текст итога берётся только из стенограммы.
    //
    // Поэтому даём прикреплённому id небольшую отсрочку (файл появляется не мгновенно),
    // а потом ищем сканом папки — с теми же защитами, что и для вкладки без id.
    if (Date.now() - (d.startedAt || 0) < TR_PIN_GRACE_MS) return null;
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
    let userText = '';
    try {
      const entries = transcript.parseEntries(tailText(file, TR_TAIL_BYTES));
      cwdInside = transcript.cwdOf(entries);
      // Kept for the tie-break below: what the agent last SAID is also on its own screen.
      text = transcript.entryText(transcript.lastMain(entries) || {});
      // А это для самого надёжного ключа: реплики ЧЕЛОВЕКА. Если вкладку ведут из телеги,
      // мост знает свой текст дословно и найдёт файл по нему (см. pickByInjected).
      userText = entries.filter((e) => e.type === 'user')
        .map((e) => transcript.entryText(e)).join('\n');
    } catch (_) {}
    cands.push({ file, mtimeMs: st.mtimeMs, cwdInside, text, userText });
  }
  const one = transcript.pickBinding(cands, { startedAt: d.startedAt, cwd: d.cwd, taken });
  if (one) return one;
  const same = cands.filter((c) => c.cwdInside === d.cwd && !taken.has(c.file));
  // Вкладку ведут из телеги? Тогда у нас есть точный ключ — наш собственный текст с меткой
  // [тлг]. Он сильнее и свежести, и экрана, поэтому пробуется первым и работает даже когда
  // в папке три живых разговора (тот случай, где вкладка оставалась без стенограммы вовсе).
  const byInjected = transcript.pickByInjected(same, d.tgLastSent);
  if (byInjected) {
    trLog(`tab=${d.name || '?'} найдена по тексту из телеги → ${path.basename(byInjected)}`);
    return byInjected;
  }
  // Ambiguous by folder — the normal case with several tabs on one repo. Match what's on
  // THIS tab's screen against each candidate's last message.
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

// Отобрать свой файл у вкладки, которая держит его по устаревшему праву.
//
// Живой случай: вкладка 3 запустилась с `--resume a7c534c7`, Клод форкнул разговор в новый
// файл, а прикреплённый id остался у вкладки 3 — и она заняла собой ЧУЖОЙ файл. Настоящий
// хозяин, вкладка 4, привязаться уже не мог (занято) и присылал в телегу строку с экрана
// вместо ответа; а вкладка 3 показывала статус чужого агента — её вердикты менялись в такт
// ходам вкладки 4. Это худшее, что этот канал умеет делать.
//
// Право сильнее прикреплённого id ровно одно: текст, который мост НАПЕЧАТАЛ сам. Метку
// [тлг] с этой формулировкой никто в другой сессии не набирал, поэтому файл, где она лежит,
// принадлежит этой вкладке — даже если его кто-то занял.
function stealByInjected(id, d, taken) {
  if (!d.tgLastSent || d.trFile) return null;
  const dir = projectDir(d.cwd);
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { return null; }
  const cands = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let userText = '';
    try {
      const entries = transcript.parseEntries(tailText(file, TR_TAIL_BYTES));
      if (transcript.cwdOf(entries) !== d.cwd) continue;
      userText = entries.filter((e) => e.type === 'user').map((e) => transcript.entryText(e)).join('\n');
    } catch (_) { continue; }
    cands.push({ file, userText });
  }
  const mine = transcript.pickByInjected(cands, d.tgLastSent);
  if (!mine) return null;
  // Освобождаем прежнего держателя: он остался без стенограммы и найдёт свою сканом.
  for (const [otherId, o] of det) {
    if (o !== d && o.trFile === mine) {
      trLog(`tab=${id} забирает ${path.basename(mine)} у tab=${otherId} (там его текст из телеги)`);
      trForget(o);
      o.claudeSessionId = null;
      applyTranscript(o, null);
      taken.delete(mine);
    }
  }
  return mine;
}

setInterval(() => {
  const now = Date.now();
  const taken = new Set();
  for (const d of det.values()) if (d.trFile) taken.add(d.trFile);
  for (const [id, d] of det) {
    if (d.dead || !d.cwd) continue;
    try {
      // Прежде всего — не держит ли кто-то файл ЭТОЙ вкладки (см. stealByInjected).
      if (!d.trFile && d.tgLastSent) {
        const mine = stealByInjected(id, d, taken);
        if (mine) {
          d.trFile = mine;
          taken.add(mine);
          d.claudeSessionId = path.basename(mine, '.jsonl');
          safeSend('session:claude', { id, claudeSessionId: d.claudeSessionId });
          if (d.tgMode) tgWriteModes();
          trLog(`tab=${id} → ${path.basename(mine)} (по тексту из телеги)`);
        }
      }
      // Bound to a session that's over? Drop it — including the id we pinned at
      // launch, which /clear has just made void — and let the scan (or the next hook
      // marker) find the new file. A frozen status is the worst thing this can do.
      if (d.trFile && now - d.trMtime > TR_STALE_MS && now - d.lastDataAt < 2000
          && newerTranscriptExists(d, taken)) {
        trLog(`tab=${id} стенограмма ${path.basename(d.trFile)} умолкла — перепривязка`);
        taken.delete(d.trFile);
        trForget(d);
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
        const stem = path.basename(file, '.jsonl');
        const byPin = stem === d.claudeSessionId;
        trLog(`tab=${id} → ${path.basename(file)}${byPin ? ' (по session id)' : ' (сканом папки)'}`);
        // Привязались сканом, хотя id был прикреплён — значит разговор идёт под ДРУГИМ
        // именем (форк от --resume, /clear). Прикреплённый id с этого момента врёт: по нему
        // хук не узнает сессию в списке «отвечаем с телефона», а следующее восстановление
        // вкладки попробует возобновить мёртвый разговор. Берём настоящий.
        if (d.claudeSessionId && !byPin) {
          d.claudeSessionId = stem;
          safeSend('session:claude', { id, claudeSessionId: stem });
          if (d.tgMode) tgWriteModes();
        }
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
      // А это — ВЕСЬ текст хода, для телеги: не только последнее сообщение, но и всё, что
      // агент говорил между инструментами (см. transcript.turnText). d.trText намеренно
      // обрезан от фразы-триггера («Сейчас от тебя: …») и годится только в подпись на плашке
      // вкладки: в чат так уезжал огрызок, хотя всё полезное агент сказал ДО этой фразы.
      if (v) d.trFinal = transcript.turnText(d.trEntries || []);
      // Итог хода — то, что мост отправляет как «вот что получилось».
      // Вместе с ним — ВРЕМЯ той записи, из которой он взят. Только по нему видно, этого хода
      // текст или прошлого: статус «готов» приходит от хука на секунду раньше, чем classify
      // отпустит свой отстой и обновит текст (см. tgOnDone).
      if (v && v.status === 'ready') {
        d.trReply = d.trFinal;
        d.trReplyAt = v.at || now;
      }
      const why = v ? v.status + (v.kind ? ':' + v.kind : '') + ' (' + v.why + ')' : 'no entries';
      if (why !== d.trWhy) { d.trWhy = why; trLog(`tab=${id} ${why}`); }
    } catch (_) {
      // File rotated, deleted, or unreadable: drop the binding and fall back to the
      // screen until we can bind again.
      trForget(d);
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
// Сколько раз отказ проверки продлевает окно (см. tgBindChat). Не безграничное: иначе код
// можно держать живым сколько угодно, присылая его раз в четверть часа.
const TG_PAIR_RENEW_MAX = 2;
// ГДЕ Я СЕЙЧАС — одно положение на всё приложение, выбранное человеком, а не догадка.
// Три варианта, и различают их два вопроса: что уезжает в телегу и можно ли маку спать.
//
//   desk  «за компом»          — в группу только вопросы и разрешения. Иначе телефон
//                                жужжал бы весь рабочий день над каждым ходом.
//   both  «с обоих устройств»  — итоги ВСЕХ ходов уезжают в группу, но сон не трогаем:
//                                ты рядом и разбудишь мак сам. Ровно то же делает галка
//                                «слать в телегу итоги всех вкладок», только та навсегда,
//                                а это — на сегодня.
//   phone «за телефоном»       — то же зеркало плюс мак не засыпает: отвечать некому,
//                                агенты живут здесь, а не на сервере.
//
// Раньше это был выключатель с двумя подписями («отошёл» / «меня нет»), и обе читались как
// объявление об отсутствии — по выключенной кнопке невозможно было понять, включён режим
// или нет.
//
// Раньше здесь стояла догадка — `powerMonitor.getSystemIdleTime() >= 300`, — и она врала в
// обе стороны. Простой считается в момент, когда ход ЗАКОНЧИЛСЯ: загрузил десяток агентов,
// встал и вышел — первые итоги приходят внутри пятиминутного окна, и ровно они, самые
// интересные, никуда не уезжали. Задел трекпад, проходя мимо, — счётчик обнулился. И
// наоборот: сидишь читаешь, мыши не касаешься пять минут — зеркало включилось само, хотя ты
// за столом. Момент, когда человек ушёл, знает только человек.
//
// Снимается тоже руками. Автоснятие по первому вводу было бы той же эвристикой с другого
// конца: разбудил мак будильником или тронул мышь через удалённый доступ — зеркало молча
// выключилось, и узнаёшь об этом по тишине в телеге, когда уже поздно.
//
// На диске НЕ хранится: приложение запустилось — значит ты за компьютером. Иначе «включил
// вчера, забыл выключить» встречало бы утром жужжащим телефоном. Кому зеркало нужно всегда,
// у того есть галка в настройках — она как раз настройка и хранится.
const TG_PRESENCE = ['desk', 'both', 'phone'];
let tgPresence = 'desk';

// Уезжают ли в группу итоги ВСЕХ ходов. Два источника, и они складываются: положение
// «где я» на сегодня и галка «слать итоги всех вкладок» навсегда. Пока галка включена,
// человек и так получает всё, поэтому «за компом» ему просто недоступно (см. renderer).
function tgMirrors() {
  return !!TG.mirrorAll || tgPresence !== 'desk';
}
// Журнал моста: каждое входящее сообщение и что мы с ним сделали — в
// <userData>/telegram.log. Пишется ВСЕГДА, и это осознанно: раньше он включался
// переменной окружения SWARM_TG_LOG, то есть ровно в тот момент, когда журнал нужен —
// «мост повёл себя странно только что» — его и не было, а включить его у уже запущенного
// приложения нельзя. Диагностика, которую надо предусмотреть заранее, не диагностика.
//
// Цена — несколько строк на сообщение из телеги, поэтому файл ограничен по размеру и
// переливается в .1: два файла, дальше старое пропадает. Ни одна ошибка здесь не имеет
// права ронять мост — журнал не важнее работы.
const TG_LOG_MAX = 512 * 1024;

function tgLogPath() { return path.join(app.getPath('userData'), 'telegram.log'); }

function tgLog(line) {
  try {
    const file = tgLogPath();
    try {
      if (fs.statSync(file).size > TG_LOG_MAX) fs.renameSync(file, file + '.1');
    } catch (_) { /* файла ещё нет — обычное дело */ }
    fs.appendFileSync(file, new Date().toISOString().slice(11, 23) + ' ' + line + '\n');
  } catch (_) { /* diagnostics must never break the bridge */ }
}

// Момент времени в том же виде, что и метка строки журнала (UTC, чч:мм:сс). Нужен, чтобы
// решение «текст этого хода или прошлого» можно было проверить по журналу, а не выводить из
// кода: без этих двух отметок «прислал старый ответ» и «прислал новый» в журнале выглядели
// одинаково, и разбор упирался в догадки.
function tgStamp(ms) {
  const t = Number(ms) || 0;
  return t ? new Date(t).toISOString().slice(11, 19) : 'никогда';
}

// What we tell an agent when its input arrives from a phone. Two ready-made wordings
// («кратко» / «полностью», telegram.PROMPTS) plus a free-text override in the panel;
// kept on one line, because it's injected as one line of terminal input.
//
// Именно ЭТА строка и есть настройка «кратко или полностью»: краткость в телеге всегда
// делалась просьбой к агенту, а не обрезкой готового ответа.
let TG_PROMPT = telegram.PROMPTS.short;

function tgPromptDefault() { return telegram.detailPrompt(TG.detail); }

// Своя формулировка перебивает пресет: человек, написавший её руками, знает, чего хочет.
function tgApplyPrompt() { TG_PROMPT = TG.prompt || tgPromptDefault(); }

let TG = { token: '', chatId: null, isForum: false, topics: {} };
let tgPoller = null;
let tgBot = '';        // bot username from getMe — shown in settings, used in the link
let tgPair = null;     // { code, at } while a pairing window is open
let tgError = null;    // last error, verbatim for the settings panel

function tgPath() { return path.join(app.getPath('userData'), 'telegram.dat'); }

function tgBlank() { return { token: '', chatId: null, isForum: false, topics: {}, prompt: '', detail: 'short', keepAwake: true, mirrorAll: false, whisperBin: '', whisperModel: '' }; }

// The last result of tgCheckChat(), so the settings panel can show «бот администратор,
// темы доступны» without re-asking Telegram on every render.
let tgCheck = null;

// Доступность шифрования — С КЭШЕМ и только по нужде.
//
// На macOS каждое обращение к safeStorage лезет в связку ключей, а приложение подписано
// ad-hoc (без Developer ID — решение пользователя). Для системы каждая пересборка это НОВОЕ
// приложение, поэтому доступ к прежней записи требует пароля. Раньше на старте таких
// обращений было два — чтение конфига и isEncryptionAvailable() из tgState(), — и пароль
// спрашивали дважды, даже у тех, кто телеграм вообще не настраивал.
//
// Теперь: если файла конфига нет, связку не трогаем совсем (у большинства — ни одного
// запроса), а результат проверки помним, чтобы не спрашивать повторно.
let tgEncOk = null;

function tgEncAvailable() {
  if (tgEncOk === null) {
    try { tgEncOk = safeStorage.isEncryptionAvailable(); } catch (_) { tgEncOk = false; }
  }
  return tgEncOk;
}

// Anything unreadable — no keychain access, a file copied from another machine, a
// half-written save — means «not configured». Never a crash on launch.
function tgLoad() {
  // Нет файла — нечего расшифровывать: молча остаёмся ненастроенными, связка не трогается.
  if (!fs.existsSync(tgPath())) { TG = tgBlank(); tgApplyPrompt(); return; }
  try {
    const d = JSON.parse(safeStorage.decryptString(fs.readFileSync(tgPath())));
    TG = {
      token: String(d.token || ''),
      chatId: Number.isFinite(d.chatId) ? d.chatId : null,
      isForum: !!d.isForum,
      topics: (d.topics && typeof d.topics === 'object') ? d.topics : {},
      prompt: String(d.prompt || ''),
      // Файл прошлой версии подробности не знает — и это ровно то, чем мост жил до сих пор.
      detail: telegram.DETAILS.includes(d.detail) ? d.detail : 'short',
      keepAwake: d.keepAwake !== false,
      mirrorAll: !!d.mirrorAll,
      whisperBin: String(d.whisperBin || ''),
      whisperModel: String(d.whisperModel || ''),
    };
  } catch (_) { TG = tgBlank(); }
  tgApplyPrompt();
}

function tgSave() {
  if (!tgEncAvailable()) {
    throw new Error('Система не даёт безопасно сохранить токен (нет доступа к keychain)');
  }
  fs.writeFileSync(tgPath(), safeStorage.encryptString(JSON.stringify(TG)), { mode: 0o600 });
}

// One call to Telegram. getUpdates holds the request open for ~25 s, so the abort timer
// must be longer than that — but finite, or a half-dead connection hangs the loop.
//
// НЕ БРОСАЕТ. Обрыв связи (сон мака, смена сети, VPN) — штатное событие для моста, а не
// исключение: пока эта функция бросала, «fetch failed» всплывал в логе приложения, а
// уведомление о запросе разрешения просто терялось. Сетевая беда выглядит здесь как обычный
// отказ Telegram (status 0), и все вызывающие, которые и так проверяют ok, ведут себя верно.
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
  } catch (e) {
    const why = (e && e.name === 'AbortError') ? 'таймаут' : ((e && e.message) || String(e));
    return { ok: false, status: 0, body: null, netError: why };
  } finally { clearTimeout(timer); }
}

// Повтор для отправки: сетевой обрыв и 5xx у Telegram — не повод терять сообщение. Три
// попытки с растущей паузой; дальше отказ уходит в журнал и в панель настроек.
const TG_SEND_TRIES = 3;

async function tgFetchWithRetry(url, body) {
  let res = null;
  for (let i = 0; i < TG_SEND_TRIES; i++) {
    res = await tgFetchJson(url, body);
    const transient = res.status === 0 || res.status >= 500;
    if (!transient) return res;
    if (i + 1 < TG_SEND_TRIES) {
      tgLog(`  сеть подвела (${res.netError || 'HTTP ' + res.status}) — повтор ${i + 2}/${TG_SEND_TRIES}`);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return res;
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
    let res = await tgFetchWithRetry(telegram.apiUrl(TG.token, 'sendMessage'), body);
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
      // Отказ Telegram — самая важная строка в журнале: без неё «в чат ничего не пришло»
      // выглядит как «приложение не пыталось», хотя оно пыталось и получило отлуп.
      tgLog(`  ✗ не отправлено (тема ${body.message_thread_id == null ? 'общая' : body.message_thread_id}):`
        + ` HTTP ${res.status} ${(res.body && res.body.description) || ''}`);
      tgPush();
      return last;
    }
    last = res.body.result && res.body.result.message_id;
    tgLog(`  → отправлено ${last} в тему ${body.message_thread_id == null ? 'общую' : body.message_thread_id}`
      + `: ${JSON.stringify(part.slice(0, 50))}`);
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

// --- Голос: установка одной кнопкой -------------------------------------------
// Пользователь не ставит ничего руками и не вбивает путей: кнопка тянет распознаватель из
// нашего же реестра (там, откуда ходят обновления) и модель с HuggingFace. В сборке нет ни
// того, ни другого — кому голос не нужен, тот не платит за него ни размером приложения, ни
// весом обновления. Ручные поля остаются для тех, у кого whisper.cpp уже стоит.
// Ассеты релизов гитхаба, публично — без токенов и учётных данных.
//
// Почему не `releases/latest/download/…`, как у обновлялки: «latest» у гитхаба — это
// самый свежий релиз ВООБЩЕ, а он почти всегда релиз приложения, и whisper.json в нём
// не лежит. Поэтому распознаватель живёт на фиксированном теге `whisper`, чей
// whisper.json перезаписывается при каждой публикации — ровно та мутабельная точка
// входа, которой раньше был путь `apps/latest/` в реестре гитлаба.
//
// И обратное требование, которое легко забыть: релизы whisper обязаны помечаться
// prerelease. Иначе свежеопубликованный распознаватель станет «latest», и обновление
// приложения начнёт получать 404 вместо манифеста. Ассеты у prerelease качаются как
// обычно, из выбора «latest» такой релиз просто исключён.
//
// Владелец и репозиторий — из package.json, одним местом на всё приложение
// (см. updaterCore.ghSlug): переименование аккаунта не должно означать правку в четырёх
// файлах, из которых один забудут.
const GH_REPO = `https://github.com/${require('./updater-core').ghSlug(require('./package.json').repository)}`;
const VOICE_REG = `${GH_REPO}/releases/download`;
const VOICE_MANIFEST_URL = `${VOICE_REG}/whisper/whisper.json`;
const VOICE_PROGRESS_MS = 200;      // как часто обновлять полосу, а не на каждый пакет

let voiceJob = null;                // идущая установка; одна за раз
let voiceError = null;

function voiceDir() { return path.join(app.getPath('userData'), voice.RUNTIME_DIRNAME); }

// Свой загрузчик, а не тот, что внутри updater.js: здесь нужен прогресс по байтам через
// несколько файлов и отмена. Редиректы `fetch` проходит сам — и модели с CDN HuggingFace,
// и ассеты гитхаба, которые тоже отдаются через 302.
async function voiceFetchFile(url, dest, opts) {
  const o = opts || {};
  const res = await fetch(url, { signal: o.signal });
  if (!res.ok || !res.body) throw new Error(`не ответил сервер (HTTP ${res.status})`);
  // Пишем в .part и переименовываем в конце: недокачанный файл никогда не должен
  // выглядеть готовым — иначе следующий запуск сочтёт его моделью и «ничего не разберёт».
  const part = dest + '.part';
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (o.onBytes) o.onBytes(chunk.length);
      if (!out.write(chunk)) await new Promise((r, j) => { out.once('drain', r); out.once('error', j); });
    }
    await new Promise((r, j) => { out.end(); out.once('finish', r); out.once('error', j); });
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(part); } catch (_) {}
    throw e;
  }
  const got = hash.digest('hex');
  if (o.sha256 && got !== String(o.sha256).toLowerCase()) {
    try { fs.unlinkSync(part); } catch (_) {}
    throw new Error('файл скачался битым (sha256 не совпал)');
  }
  fs.renameSync(part, dest);
}

// План установки с учётом того, что уже лежит: повторное нажатие после обрыва не тянет
// заново 148 МБ. Целость по размеру, а не по хешу: хешировать модель при каждом открытии
// настроек — ощутимая пауза, а битое отсекается при скачивании.
async function voicePlan(modelId) {
  const res = await fetch(VOICE_MANIFEST_URL);
  if (!res.ok) throw new Error(`список сборок распознавателя недоступен (HTTP ${res.status})`);
  const manifest = await res.json();
  const args = {
    dir: voiceDir(), platform: process.platform, arch: process.arch, modelId, manifest,
    base: `${VOICE_REG}/whisper-${manifest.version}`, join: path.join,
  };
  const full = voice.installPlan(args);
  if (!full.ok) return full;
  const have = new Set();
  for (const it of full.items) {
    try { if (fs.statSync(it.target).size === it.bytes) have.add(it.name); } catch (_) {}
  }
  return voice.installPlan(Object.assign({ have }, args));
}

let voicePushAt = 0;
function voicePush(force) {
  const now = Date.now();
  if (!force && now - voicePushAt < VOICE_PROGRESS_MS) return;
  voicePushAt = now;
  tgPush();
}

async function voiceInstall(modelId) {
  if (voiceJob) return;
  voiceError = null;
  const ctl = new AbortController();
  voiceJob = { total: 0, done: 0, what: 'подготовка', ctl };
  voicePush(true);
  try {
    const plan = await voicePlan(modelId);
    if (!plan.ok) {
      throw new Error('для этой системы готовой сборки распознавателя нет —'
        + ' поставь whisper.cpp сам и укажи путь вручную');
    }
    voiceJob.total = plan.bytes;
    fs.mkdirSync(voiceDir(), { recursive: true });
    for (const it of plan.items) {
      voiceJob.what = it.kind === 'model' ? 'модель' : 'распознаватель';
      voicePush(true);
      await voiceFetchFile(it.url, it.target, {
        sha256: it.sha256,
        signal: ctl.signal,
        onBytes: (n) => { voiceJob.done += n; voicePush(); },
      });
      // Без +x скачанный бинарник просто не запустится, а «whisper не отработал» —
      // бесполезная диагностика для того, кто ничего руками не делал.
      if (it.exec) { try { fs.chmodSync(it.target, 0o755); } catch (_) {} }
    }
    TG.whisperBin = plan.bin;
    TG.whisperModel = plan.model;
    try { tgSave(); } catch (e) { reportMainError(e); }
  } catch (e) {
    voiceError = ctl.signal.aborted ? 'Установка отменена.'
      : 'Не получилось установить голос: ' + ((e && e.message) || e);
  } finally {
    voiceJob = null;
    voicePush(true);
  }
}

// Вернуть мегабайты: удалить скачанное и забыть пути. Ровно то, чего не хватает, когда
// функцию попробовали и решили, что она не нужна.
function voiceRemove() {
  if (voiceJob) { voiceJob.ctl.abort(); }
  try { fs.rmSync(voiceDir(), { recursive: true, force: true }); } catch (e) { reportMainError(e); }
  // Ручные пути (whisper из PATH) не трогаем — удаляем только то, что установили сами.
  if (String(TG.whisperBin || '').startsWith(voiceDir())) TG.whisperBin = '';
  if (String(TG.whisperModel || '').startsWith(voiceDir())) TG.whisperModel = '';
  voiceError = null;
  try { tgSave(); } catch (e) { reportMainError(e); }
}

// Сколько места занято скачанным — чтобы кнопка «Удалить» называла цифру.
function voiceDiskBytes() {
  let sum = 0;
  try {
    for (const f of fs.readdirSync(voiceDir())) {
      try { sum += fs.statSync(path.join(voiceDir(), f)).size; } catch (_) {}
    }
  } catch (_) { /* папки нет — ноль */ }
  return sum;
}

// Какая модель установлена: узнаём по имени файла, отдельного состояния не держим.
function voiceInstalledModel() {
  const m = /ggml-([a-z0-9.-]+)\.bin$/.exec(String(TG.whisperModel || ''));
  return m ? m[1] : null;
}

function voiceState() {
  return {
    busy: !!voiceJob,
    what: voiceJob ? voiceJob.what : '',
    done: voiceJob ? voiceJob.done : 0,
    total: voiceJob ? voiceJob.total : 0,
    error: voiceError,
    model: voiceInstalledModel(),
    managed: String(TG.whisperModel || '').startsWith(voiceDir()),
    diskBytes: voiceDiskBytes(),
    models: voice.MODELS.map((m) => ({ id: m.id, label: m.label, bytes: m.bytes, note: m.note,
      recommended: !!m.recommended })),
  };
}

ipcMain.handle('voice:install', (_e, modelId) => { voiceInstall(String(modelId || 'base')).catch(reportMainError); return tgState(); });
ipcMain.handle('voice:cancel', () => { if (voiceJob) voiceJob.ctl.abort(); return tgState(); });
ipcMain.handle('voice:remove', () => { voiceRemove(); return tgState(); });

// Показать журнал моста в Finder/Проводнике. Нужно, чтобы «пришли журнал» не означало
// «открой терминал и найди папку профиля приложения».
ipcMain.handle('telegram:showLog', () => {
  const file = tgLogPath();
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'журнал пуст — мост ещё ничего не делал\n');
    shell.showItemInFolder(file);
    return true;
  } catch (e) { reportMainError(e); return false; }
});

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

// Дольше этого голосовое не берём. Двухминутная запись — это уже не «сказал на ходу», а
// монолог: распознавание займёт больше, чем есть терпения, и почти всегда это случайно
// зажатая кнопка. Отказ приходит сразу, ДО скачивания, поэтому стоит он ноль.
const TG_VOICE_MAX_S = 120;
// Больше самой длинной допустимой записи с запасом: реальная фраза успевает, а зависший
// бинарник (не та модель, битый файл) всё равно будет убит и ответит ошибкой.
const TG_WHISPER_TIMEOUT_MS = 180000;

// Голосовое → текст. Возвращает { text } или { error } — текст ошибки уходит в чат как
// есть, потому что человек с телефоном должен понимать, что чинить. Ни один путь отсюда не
// имеет права бросить: голосовое, на которое не пришло НИЧЕГО, выглядит как сдохший мост.
async function tgVoiceToText(fileId) {
  const bin = tgWhisperBin();
  if (!bin || !TG.whisperModel) {
    return { error: 'Голос не настроен: укажи путь к whisper.cpp и модели в «Настройки → Телеграм».' };
  }
  let wav = null;
  try {
    // Сеть здесь рвётся штатно (телефон в метро, мак ушёл в сон): fetch в этом случае не
    // возвращает ошибку, а БРОСАЕТ, и без try весь ответ на голосовое сводился к записи в
    // лог main-процесса — в чате тишина.
    const info = await tgFetchJson(telegram.apiUrl(TG.token, 'getFile'), { file_id: fileId });
    const fpath = info.ok && info.body && info.body.ok === true && info.body.result && info.body.result.file_path;
    if (!fpath) return { error: 'Не смог забрать файл у Telegram.' };
    const res = await fetch(`${telegram.API_HOST}/file/bot${TG.token}/${fpath}`);
    if (!res.ok) return { error: 'Не смог скачать голосовое.' };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const decoded = await tgDecodeAudio(bytes);
    if (decoded.error || !decoded.samples || !decoded.samples.length) {
      return { error: 'Не смог декодировать запись: ' + (decoded.error || 'пусто') };
    }
    wav = path.join(os.tmpdir(), `swarm-voice-${Date.now()}.wav`);
    fs.writeFileSync(wav, voice.wavFromFloat32(decoded.samples, voice.SAMPLE_RATE));
    const out = await new Promise((resolve, reject) => {
      execFile(bin, voice.whisperArgs({ model: TG.whisperModel, wav }),
        { timeout: TG_WHISPER_TIMEOUT_MS, maxBuffer: 4 << 20 },
        (err, stdout, stderr) => {
          // Убит по таймауту или по переполнению буфера — то, что успело напечататься,
          // это ОБРЕЗАННАЯ фраза. Отдать её как результат хуже, чем ошибка: агент начнёт
          // работать по половине задачи, и никто не заметит, по какой именно.
          if (err && (err.killed || err.signal)) {
            reject(new Error(err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'напечатал слишком много — похоже, это не тот бинарник'
              : `не уложился в ${Math.round(TG_WHISPER_TIMEOUT_MS / 1000)} с — проверь модель и путь к бинарнику`));
            return;
          }
          // Ненулевой код при живом выводе терпим: некоторые сборки whisper.cpp ругаются
          // в stderr и всё равно печатают текст.
          if (err && !stdout) { reject(new Error(String(stderr || err.message).slice(0, 200))); return; }
          resolve(stdout);
        });
    });
    const text = voice.parseOutput(out);
    return text ? { text } : { error: 'Ничего не разобрал — тишина или слишком коротко.' };
  } catch (e) {
    return { error: 'Голосовое не получилось расшифровать: ' + ((e && e.message) || e) };
  } finally {
    if (wav) { try { fs.unlinkSync(wav); } catch (_) {} }
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
// Результат — СПИСОК пунктов, а не одна фраза. Раньше проверка возвращала первую же
// найденную беду («в группе не включены темы»), и что там с правами бота, человек узнавал
// только починив темы и нажав «проверить» снова: настройка вслепую, шаг за шагом. Мастер в
// настройках показывает все пункты разом, поэтому здесь собирается всё, что удалось узнать.
//
// ok у пункта троичный: true — сделано, false — не сделано, null — проверить не удалось
// (предыдущий пункт не пройден, дальше спрашивать бесполезно). Врать галочкой там, где мы
// не знаем, нельзя: человек пойдёт чинить не то.
// soft — пункт, без которого мост всё-таки работает: он не отменяет привязку, но и молчать
// о нём нельзя, иначе «почему закрытые темы копятся» станет загадкой.
function tgChk(id, label, ok, hint, soft) { return { id, label, ok, hint: hint || '', soft: !!soft }; }

// Одна фраза для тех мест, где список не нарисовать: отказ при привязке уходит В ЧАТ, и там
// нужно ровно одно предложение — что чинить прямо сейчас.
function tgCheckNote(checks, title) {
  const bad = checks.find((c) => c.ok === false && !c.soft);
  if (bad) return bad.hint;
  const soft = checks.find((c) => c.ok === false && c.hint);
  return `«${title}»: бот администратор, темы доступны.` + (soft ? ' ' + soft.hint : '');
}

async function tgCheckChat(chatId) {
  const target = chatId != null ? chatId : TG.chatId;
  if (!TG.token || target == null) return null;
  const chat = await tgFetchJson(telegram.apiUrl(TG.token, 'getChat'), { chat_id: target });
  if (!chat.ok || !chat.body || chat.body.ok !== true) {
    const why = telegram.classifyError(chat.status, chat.body).message;
    return { ok: false, title: '', isForum: false, note: why,
      checks: [tgChk('group', 'Группа доступна боту', false, why)] };
  }
  const info = chat.body.result || {};
  const title = info.title || info.username || 'чат';
  const isForum = !!info.is_forum;
  const isGroup = info.type === 'group' || info.type === 'supergroup';
  const checks = [tgChk('group', 'Это группа, а не личный чат', isGroup,
    isGroup ? '' : 'Личный чат не подойдёт: вкладок много, и различать их нужно темами.'
      + ' Создай группу, включи в ней «Темы», добавь туда бота администратором — и привяжи её.')];
  checks.push(tgChk('topics', 'В группе включены темы', isGroup ? isForum : null,
    !isGroup || isForum ? '' : `В «${title}» не включены темы. Настройки группы → «Темы» →`
      + ' включить. Обычная группа без тем не подойдёт: каждая вкладка живёт в своей теме.'));

  const me = isGroup && isForum
    ? await tgFetchJson(telegram.apiUrl(TG.token, 'getChatMember'),
      { chat_id: target, user_id: Number(String(TG.token).split(':')[0]) })
    : null;
  const member = (me && me.ok && me.body && me.body.ok === true && me.body.result) || null;
  const status = member ? member.status : '';
  const inChat = member ? !(status === 'left' || status === 'kicked') : null;
  checks.push(tgChk('member', 'Бот добавлен в группу', me ? !!inChat : null,
    !me || inChat ? '' : `Бота нет в «${title}» — добавь его в группу.`));

  const admin = inChat ? (status === 'administrator' || status === 'creator') : (inChat === null ? null : false);
  checks.push(tgChk('admin', 'Бот — администратор', admin,
    admin !== false ? '' : `В «${title}» бот не администратор. Без этого Телеграм не покажет ему`
      + ' обычные сообщения в темах (режим приватности) и не даст создавать темы.'));

  const manage = admin ? member.can_manage_topics !== false : (admin === null ? null : false);
  checks.push(tgChk('manage', 'Право «Управление темами»', manage,
    manage !== false ? '' : `В «${title}» у бота нет права «Управление темами» — вкладки не`
      + ' получат своих тем. Включи это право в его админ-настройках.'));

  // Право на удаление — не гейт: без него мост работает, просто закрытые вкладки оставляют
  // за собой тему с замочком.
  const del = admin ? member.can_delete_messages !== false : (admin === null ? null : false);
  checks.push(tgChk('delete', 'Право «Удаление сообщений»', del,
    del !== false ? '' : 'Добавь боту право «Удаление сообщений» — иначе темы закрытых вкладок'
      + ' останутся в списке с замочком вместо того, чтобы исчезать.', true));

  const ok = !!(isGroup && isForum && inChat && admin && manage);
  return { ok, title, isForum, checks, note: tgCheckNote(checks, title) };
}

function tgState() {
  return {
    // Не дёргаем связку ключей ради отрисовки настроек: пока никто не сохранял токен,
    // считаем, что всё в порядке. Настоящая проверка случится при сохранении — там же, где
    // от неё есть польза, и с внятной ошибкой, если система откажет.
    available: tgEncOk === null ? true : tgEncOk,
    configured: !!TG.token,
    masked: telegram.maskToken(TG.token),
    bot: tgBot,
    chatId: TG.chatId,
    isForum: TG.isForum,
    live: !!(tgPoller && tgPoller.alive),
    error: tgError,
    prompt: TG.prompt || '',
    // Что подставится, если своя формулировка пуста, — оно же и подсказка в поле.
    promptDefault: tgPromptDefault(),
    detail: TG.detail || 'short',
    keepAwake: !!TG.keepAwake,
    mirrorAll: !!TG.mirrorAll,
    // «Где я» — не настройка, а положение дел прямо сейчас; кнопка в строке состояния
    // рисуется по нему же, поэтому едет вместе с остальным состоянием моста.
    presence: tgPresence,
    whisperBin: TG.whisperBin,
    whisperModel: TG.whisperModel,
    voiceHint: voice.setupHint(process.platform),
    voiceReady: !!(tgWhisperBin() && TG.whisperModel),
    voice: voiceState(),
    check: tgCheck,
    pairing: tgPair ? { code: tgPair.code, until: tgPair.at + TG_PAIR_TTL_MS } : null,
  };
}

function tgPush() { safeSend('telegram:state', tgState()); }

// Не давать системе уснуть — пока человека нет за компьютером. Только «app suspension»:
// экран пусть гаснет, нам важно, чтобы процесс продолжал опрашивать телегу.
//
// Именно «за телефоном», а не круглосуточно при привязанной группе, как было раньше:
// за столом сон никому не мешает — ты рядом и сам разбудишь мак, — а держать батарею
// разряженной весь день ради моста, которым в эту минуту не пользуешься, незачем. И зеркало
// на обоих устройствах сна тоже не отменяет: смотреть в телегу, сидя за столом, — не то же
// самое, что уехать и остаться с одним телефоном.
let tgAwakeId = null;

function tgApplyKeepAwake() {
  const want = !!(TG.keepAwake && tgPresence === 'phone' && TG.token && TG.chatId != null);
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
  // Список команд для кнопки «Меню» у поля ввода: с телефона «/mode auto» набирать неудобно,
  // а в меню это выбор из списка с описанием. Ставится при каждом подключении — дешевле, чем
  // помнить, ставили ли уже, и переживает смену набора команд между версиями.
  tgFetchJson(telegram.apiUrl(TG.token, 'setMyCommands'), {
    commands: telegram.COMMANDS,
    scope: { type: 'all_group_chats' },
  }).catch(reportMainError);
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
  // Под шапкой темы — кнопки частых действий. Смысл: с телефона не надо набирать команды,
  // а шапка всегда наверху темы, то есть это постоянная панель управления вкладкой.
  tgRemember(await tgSend({
    threadId,
    text: `Вкладка «${tgTabName(id)}».${where}\n\nПиши сюда — попадёт в этого агента.`,
    silent: true,
    replyMarkup: telegram.actionKeyboard(String(id)),
  }), id);
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
  // Отложенный итог тоже отменяем: докладывать за вкладку, которой уже нет, некому и незачем.
  if (d.tgDoneTimer) { clearTimeout(d.tgDoneTimer); d.tgDoneTimer = null; }
  tgClearMode(d);
  tgCloseTopic(d);             // the topic list mirrors the open tabs
}

// Вкладку закрыли — тему СНОСИМ, а не закрываем. Закрытая тема остаётся в списке группы с
// замочком: список тем должен быть списком открытых вкладок, а не музеем закрытых. Вместе с
// темой пропадает и её переписка — это осознанно, чат здесь зеркало живых вкладок, а не
// архив (история хода целиком есть в самой вкладке и в стенограмме Клода).
//
// ВАЖНО: не при выходе из приложения. На закрытии окна умирают все pty сразу, и снос тут
// стирал бы всю группу при каждом перезапуске, хотя вкладки вернутся и займут свои темы.
function tgCloseTopic(d) {
  const threadId = tgTopicOf(d);
  if (!threadId || TG.chatId == null) return;
  if (allowClose) return;              // приложение закрывается — темы переживут перезапуск
  tgDeleteTopic(threadId).catch(reportMainError);
}

// Снос темы. Требует права «Удаление сообщений»: без него Telegram отвечает отказом, и
// молча оставить тему висеть — значит соврать пользователю, что убрали. Поэтому откат на
// закрытие плюс внятная ошибка в настройках.
async function tgDeleteTopic(threadId) {
  const res = await tgFetchJson(telegram.apiUrl(TG.token, 'deleteForumTopic'),
    { chat_id: TG.chatId, message_thread_id: threadId });
  if (res.ok && res.body && res.body.ok === true) {
    tgLog(`  тема ${threadId} снесена`);
    tgForgetTopic(threadId);           // карта не должна помнить то, чего больше нет
    return;
  }
  const why = (res.body && res.body.description) || `HTTP ${res.status}`;
  tgLog(`  ✗ тему ${threadId} снести не смог: ${why} — закрываю`);
  tgError = 'Чтобы закрытые вкладки исчезали из группы, боту нужно право «Удаление'
    + ' сообщений» в админ-настройках. Пока темы будут просто закрываться.';
  tgPush();
  await tgSend({ threadId, text: '⚪ вкладка закрыта', silent: true });
  await tgTopicCall('closeForumTopic', threadId);
}

// --- синк в обратную сторону: телега → сворм -----------------------------------
// Имя вкладки живёт в двух местах сразу — в списке вкладок на маке и в названии темы, — но
// ехало до сих пор только в одну сторону. А с телефона переименовать тему это ЕДИНСТВЕННЫЙ
// способ навести порядок в группе, и человек, сделавший это в дороге, получал расхождение:
// в телеге «оплата», на маке всё ещё «claude 3», и /tabs называл вкладку старым именем.
//
// Петли здесь нет: наше собственное editForumTopic возвращается тем же событием, но к этому
// моменту имя вкладки уже такое же, и мы ничего не делаем.
async function tgOnService(u) {
  const kind = u.service.kind;
  const id = tgRoute(u);
  const d = id == null ? null : det.get(id);
  if (kind === 'topic-edited') {
    const name = u.service.name;
    if (!d || !name || name === d.name) return;
    tgLog(`  тему ${u.threadId} переименовали в «${name}» — переношу на вкладку ${id}`);
    d.name = name;
    d.tgTopicName = name;          // в телеге это имя уже стоит, ехать обратно нечему
    safeSend('app:renameTab', { id, name });
    return;
  }
  if (kind === 'topic-closed') {
    // Тему закрыли руками, а вкладка на маке жива — может быть, прямо сейчас работает.
    // Молча завершить агента по жесту в чате нельзя: вместе с ним пропадёт незаконченный
    // ход. Молча оставить как есть — тоже плохо: писать в закрытую тему человек больше не
    // может, и мост для этой вкладки выглядит сломанным. Поэтому спрашиваем, двумя кнопками.
    //
    // Наш собственный откат (не удалось снести тему — закрываем её, см. tgDeleteTopic)
    // приходит сюда же, но там вкладки уже нет, и вопрос не задаётся.
    if (!d || d.dead) return;
    tgLog(`  тему ${u.threadId} закрыли руками — спрашиваю, что делать со вкладкой ${id}`);
    tgRemember(await tgSend({
      threadId: u.threadId,
      text: `Тема закрыта, а вкладка «${tgTabName(id)}» на маке ещё работает.`
        + '\n\n↩️ вернуть тему — открою её обратно, и продолжим здесь.'
        + '\n✖️ закрыть вкладку — агент завершится, тема исчезнет из группы.',
      replyMarkup: telegram.actionKeyboard(String(id), ['reopen', 'kill']),
    }), id);
    return;
  }
  if (kind === 'topic-reopened' && d) tgLog(`  тему ${u.threadId} открыли обратно`);
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
      if (TG.topics[d.tabKey]) {
        tgTopicSession.set(TG.topics[d.tabKey], id);
        // Заодно подтягиваем название темы под имя вкладки: /sync — это «пусть в группе будет
        // то же, что на машине», и разъехавшиеся имена сюда тоже входят. Вкладки, чьё имя и
        // так совпадает, ничего не стоят — tgRenameTopic на них молчит.
        tgRenameTopic(id);
        continue;
      }
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
// Пауза между текстом и Enter. Смысл в том, чтобы Enter пришёл ОТДЕЛЬНЫМ чтением stdin, а
// не хвостом вставки — почему это важно, написано у telegram.inputWrites. Достаточно
// маленькая, чтобы человек не заметил, и достаточно большая, чтобы Ink успел разобрать
// первый кусок как ввод, а не склеить оба в один.
const TG_ENTER_DELAY_MS = 90;

function tgAnswer(id, text) {
  const p = sessions.get(id);
  if (!p) return false;
  const [body, enter] = telegram.inputWrites(text);
  if (!body) return false;
  p.write(body);
  // Запоминаем ДОСЛОВНО напечатанное: по этому тексту стенограмма находит файл вкладки,
  // когда в папке несколько живых разговоров и догадки не срабатывают.
  //
  // Только если текст достаточно длинный, чтобы что-то доказывать (та же граница, что у
  // transcript.pickByInjected). Иначе номер варианта, напечатанный кнопкой разрешения, затирал
  // ключ — вкладка отвечала из телеги, а найти свой файл ей было уже нечем.
  const dd = det.get(id);
  const typed = String(text).replace(/\r\n?/g, '\n');
  if (dd && typed.trim().length >= transcript.INJECTED_MIN) dd.tgLastSent = typed.slice(0, 200);
  setTimeout(() => {
    // Вкладка могла умереть за эти миллисекунды — тогда Enter уже некому.
    const live = sessions.get(id);
    if (live) { try { live.write(enter); } catch (_) {} }
  }, TG_ENTER_DELAY_MS);
  const d = det.get(id);
  if (d) {
    markAnswered(d, Date.now());
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
  // Уже запланировано ИЛИ уже отправлено — второй раз то же самое не присылаем. Оба условия
  // нужны, потому что дублей было два источника:
  //   • пока сообщение летит (с повторами это секунды), tgTimer уже сброшен, и такт заводил
  //     вторую отправку;
  //   • ожидание перерисовывается — меняется текст вопроса, — и ветка «статус изменился»
  //     звала уведомление снова, хотя вкладка ждёт того же самого.
  // Отметка снимается в tgCancelWaiting, то есть когда вкладка перестала ждать: следующее
  // ожидание — новый повод написать.
  if (d.tgTimer || d.tgNotifiedAt) return;
  d.tgTimer = setTimeout(() => {
    d.tgTimer = null;
    if (d.dead || d.status !== 'waiting') return;   // resolved at the keyboard already
    // Помечаем ДО отправки, иначе такт (каждые 400 мс) успеет начать вторую.
    d.tgNotifiedAt = Date.now();
    tgNotifyWaiting(id, d).catch((e) => { tgNotifyFailed(d); reportMainError(e); });
  }, TG_NOTIFY_DELAY_MS);
}

function tgCancelWaiting(d) {
  if (!d) return;
  if (d.tgTimer) { clearTimeout(d.tgTimer); d.tgTimer = null; }
  // Вкладка больше не ждёт: следующее ожидание — новый повод уведомить, и повод свежий, так
  // что счётчик отказов начинается заново.
  d.tgNotifiedAt = 0;
  d.tgFails = 0;
  d.tgRetryAt = 0;
}

// Отправка уведомления не удалась. Отметку «уже написали» снимаем (такт попробует снова), но
// НЕ сразу: пока здесь не было откола, недоступный Telegram означал поток из трёх запросов
// раз в полторы секунды всё время, пока вкладка ждёт, — и три строки в журнал на каждую
// попытку, то есть журнал моста перелистывался и стирал ровно ту историю, ради которой он
// включён всегда. Шаг тот же, что у опроса (telegram.backoffMs): до минуты и не больше.
function tgNotifyFailed(d) {
  if (!d) return;
  d.tgNotifiedAt = 0;
  d.tgFails = (d.tgFails || 0) + 1;
  const wait = telegram.backoffMs(d.tgFails);
  d.tgRetryAt = Date.now() + wait;
  tgLog(`  ✗ уведомление не ушло (попытка ${d.tgFails}) — следующая через ${Math.round(wait / 1000)} с`);
}

// The agent finished a turn it was given from the phone: send back what it said. Only
// for tabs in Telegram mode — otherwise every turn you run at your own desk would land
// in the chat and the bridge would become a log nobody reads.
// --- одно сообщение на ход: «думаю» → ответ -----------------------------------
// Раньше в тему уезжала стрелочка с именем вкладки, а потом отдельным сообщением итог. По
// стрелочке нельзя было понять, работает агент или всё заглохло, а лента распухала вдвое.
// Теперь подтверждение — это ЗАГОТОВКА ответа: то же сообщение переписывается на итог,
// когда ход закончится. Голосовое присылает расшифровку ОТДЕЛЬНЫМ сообщением до неё —
// его никто не переписывает, поэтому «услышал: RoseVPN» остаётся на месте, что бы ни
// случилось с ответом.
const TG_THINKING = '⏳ получил, думаю…';

async function tgAckSend(id, d, u) {
  // Прислали два сообщения подряд, не дожидаясь ответа: заготовка одна на ход, поэтому старую
  // надо ЗАКРЫТЬ. Иначе она остаётся в ленте с вечным «думаю…» — и человек ждёт ответа на
  // первое сообщение, которого уже никогда не будет.
  if (d && d.tgAck) {
    const old = d.tgAck;
    d.tgAck = null;
    await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'),
      { chat_id: old.chatId, message_id: old.messageId, text: '⏳ принято — отвечу ниже' })
      .catch(reportMainError);
  }
  const msgId = await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: TG_THINKING, silent: true });
  tgRemember(msgId, id);          // ответом на него тоже можно продолжать разговор
  if (d && msgId) d.tgAck = { messageId: msgId, chatId: TG.chatId };
}

// Переписать заготовку. Не вышло (сообщение удалили, прошли сутки, чат сменился) — отправим
// обычным сообщением: тишина вместо ответа хуже лишней записи в ленте.
async function tgAckResolve(id, d, text) {
  const ack = d && d.tgAck;
  const body = String(text);
  if (!ack || ack.chatId !== TG.chatId) {
    const msgId = await tgSend({ threadId: await tgTopicFor(id), text: body });
    tgRemember(msgId, id);
    return;
  }
  d.tgAck = null;
  // Слишком длинный ответ в правку не влезет: Telegram режет сообщение на 4096, а правку
  // просто отвергает целиком. Тогда заготовка становится указателем, а сам ответ уходит
  // обычным сообщением — там он разобьётся на части штатно.
  if (body.length > telegram.MAX_TEXT - 64) {
    await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'),
      { chat_id: ack.chatId, message_id: ack.messageId, text: '✅ ответил — ниже' });
    const longId = await tgSend({ threadId: await tgTopicFor(id), text: body });
    tgRemember(longId, id);
    return;
  }
  const res = await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'),
    { chat_id: ack.chatId, message_id: ack.messageId, text: body });
  if (res.ok && res.body && res.body.ok === true) {
    tgLog(`  → ответ вписан в сообщение ${ack.messageId}`);
    return;
  }
  tgLog(`  ✗ не смог переписать ${ack.messageId}: ${(res.body && res.body.description) || res.status}`);
  const msgId = await tgSend({ threadId: await tgTopicFor(id), text: body });
  tgRemember(msgId, id);
}

// Итог хода отправляется НЕ в тот же миг, когда статус стал «готов».
//
// С включёнными хуками Stop прилетает раньше, чем стенограмма догоняет: у classify свой
// отстой (transcript.READY_DEBOUNCE_MS), и до его истечения d.trReply — это текст ПРОШЛОГО
// хода. Отправить его — худшее, что тут можно сделать: в чат уходит правдоподобный ответ не
// на ту задачу, и заметить подмену нельзя ничем. Поэтому ждём, пока текст хода станет свежим
// (его запись позже начала хода), и только потом докладываем. Не дождались — честно берём
// экран, а не выдаём чужой текст за этот ход.
const TG_DONE_STEP_MS = 300;      // как часто переспрашивать стенограмму
const TG_DONE_WAIT_MS = 3000;     // сколько всего ждать; дальше отчёт по экрану

function tgOnDone(id, d) {
  if (d.tgDoneTimer) return;      // этот ход уже ждёт своей очереди
  const endedAt = Date.now();
  const step = () => {
    d.tgDoneTimer = null;
    if (d.dead) return;
    // Вкладка успела снова заработать: этот ход уже не итог, а следующий доложит о себе сам.
    if (d.status !== 'ready') return;
    const fresh = transcript.belongsToTurn(d.trReplyAt, d.turnStartedAt);
    if (!fresh && Date.now() - endedAt < TG_DONE_WAIT_MS) {
      d.tgDoneTimer = setTimeout(step, TG_DONE_STEP_MS);
      return;
    }
    tgNotifyDone(id, d, fresh).catch(reportMainError);
  };
  d.tgDoneTimer = setTimeout(step, TG_DONE_STEP_MS);
}

async function tgNotifyDone(id, d, fresh) {
  // Текст итога — дословный из стенограммы, а если её нет, последнее сообщение с ЭКРАНА.
  // Пустой отчёт «✅ вкладка — готов.» бесполезен: человек в дороге узнаёт, что ход
  // закончился, но не узнаёт чем. Экран беднее (шире окна эмулятора он не видит и переносы
  // в нём терминальные), зато он есть всегда.
  // `fresh` — принадлежит ли текст стенограммы ЭТОМУ ходу (см. tgOnDone). Не принадлежит —
  // значит его нет, и никакой «почти подходящий» текст его не заменяет.
  const fromTr = fresh ? String(d.trReply || '').trim() : '';
  // lastAgentBlock, а НЕ extractQuestion: вторая берёт нижнюю значимую строку, а внизу стоит
  // поле ввода — из-за этого в чат уезжала то линейка рамки, то собственный вопрос
  // пользователя, отражённый ему же как «ответ агента». И не lastAgentLine: одна строка —
  // это огрызок ответа, а человеку нужен ответ.
  const text = fromTr || String(lastAgentBlock(replySnapshot(d)) || '').trim();
  // Источник называем ЧЕСТНО, включая «текст стенограммы не от этого хода»: пометка
  // «стенограмма» на чужом тексте однажды уже отправила искать не ту проблему.
  const why = fromTr ? 'стенограмма'
    : !d.trFile ? (text ? 'экран, стенограмма не привязана' : 'ни стенограммы, ни экрана')
      : text ? 'экран, стенограмма не догнала этот ход' : 'стенограмма не догнала, экран пуст';
  // Тот же итог второй раз — это не итог, а шум, и человек в чате отличить его от нового
  // ответа не может. Живой случай: вкладка, в которой ничего не происходит, раз в полчаса
  // присылала один и тот же ответ — Claude Code перерисовывает экран (и дёргает хуки) на
  // своих таймерах, приложение видит короткое «работает → готов», и мост честно докладывает
  // ход, которого не было. Никакая проверка свежести это не лечит: текст-то настоящий, он
  // просто уже отправлен. Поэтому ключ отчёта — запись стенограммы (её время), а без
  // стенограммы сам текст; совпал с прошлым — молчим.
  //
  // Долг (в чате висит «получил, думаю…») сильнее: там человек ЖДЁТ ответа именно на своё
  // сообщение, и оставить его с часиками навсегда — хуже, чем повторить текст.
  const key = fresh ? `tr:${d.trReplyAt}` : `screen:${text}`;
  if (!d.tgAck && key === d.tgSentKey) {
    tgLog(`  → итог вкладки ${id} не изменился (${why}) — не повторяю`);
    return;
  }
  d.tgSentKey = key;
  tgLog(`  → итог вкладки ${id}: ${text ? text.length + ' симв.' : 'текста нет'} (${why};`
    + ` ход с ${tgStamp(d.turnStartedAt)}, текст ${tgStamp(d.trReplyAt)})`);
  // Если ход начался сообщением из телеги, ответ вписывается в ЕГО же сообщение («получил,
  // думаю…» → ответ). Иначе (зеркало итогов, когда человека нет за маком) — обычная запись.
  await tgAckResolve(id, d, `✅ ${tgTabName(id)}${text ? '\n\n' + text : ' — готов.'}`);
}

async function tgNotifyWaiting(id, d) {
  const permission = d.waitingKind === 'permission';
  const threadId = await tgTopicFor(id);
  tgLog(`  → ${permission ? 'запрос разрешения' : 'вопрос'} вкладки ${id} в тему ${threadId == null ? 'общую' : threadId}`);
  // A permission is answered with BUTTONS carrying Claude's own options — never with free
  // text. You approve what you see: the request (with the command in it) is in the message,
  // and nothing that wasn't on Claude's list can be chosen. Typing «да» here still gets
  // refused, because a word is not a choice from a list.
  const prompt = permission ? parsePrompt(snapshot(d)) : null;
  if (prompt && prompt.options.length) {
    const kb = telegram.inlineKeyboard(prompt.options, String(id), prompt.fingerprint);
    if (kb) {
      // Кнопки — отдельным сообщением: отпечаток строится при отправке, и клавиатура должна
      // висеть на свежей записи. А заготовка «думаю…» превращается в указатель, иначе она
      // осталась бы врать, что агент ещё думает.
      if (d.tgAck) await tgAckResolve(id, d, `🔐 ${tgTabName(id)} просит разрешение — кнопки ниже`);
      // Части запроса — каждая своей строкой: «Bash command · rm -rf build · Do you want to
      // proceed?» одной строкой на телефоне читается как мешанина, а решение по нему
      // принимают за секунды и не разглядывая.
      const msgId = await tgSend({
        threadId,
        text: `🔐 ${tgTabName(id)} просит разрешение\n\n${prompt.title.split(' · ').join('\n')}`,
        replyMarkup: kb,
      });
      tgRemember(msgId, id);
      // Не приняли (сеть) — снимаем отметку с отколом, и такт попробует снова. Ставится она
      // ДО отправки, в tgOnWaiting: иначе между попыткой и успехом влезает второе уведомление.
      if (!msgId) tgNotifyFailed(d); else { d.tgFails = 0; d.tgRetryAt = 0; }
      return;
    }
  }
  const head = permission ? '🔐 просит разрешение' : '❓ вопрос';
  // Целиком, а не огрызок с «Сейчас от тебя»: человек в дороге читает ход один раз, и
  // выводы агента ему нужны не меньше самого вопроса. Без стенограммы — сообщение с экрана
  // целиком; d.question (одна строка для плашки вкладки) остаётся последним запасом, из-за
  // него в чат уезжало «Jump to bottom (click) ↓» вместо вопроса.
  const said = String(d.trFinal || '').trim()
    || String(lastAgentBlock(replySnapshot(d)) || '').trim()
    || d.question;
  const body = said ? '\n\n' + said : '';
  const tail = permission
    ? '\n\nВариантов не разобрал — ответь за компьютером.'
    : '\n\nОтветь реплаем на это сообщение.';
  const full = `${head} · ${tgTabName(id)}${body}${tail}`;
  // Вопрос прозой — это и есть исход хода, значит он вписывается в ту же заготовку: реплай
  // на неё маршрутизируется в ту же вкладку, потому что её id мы запомнили при отправке.
  if (d.tgAck) { await tgAckResolve(id, d, full); return; }
  const msgId = await tgSend({ threadId, text: full });
  if (!permission) tgRemember(msgId, id);
  if (!msgId) tgNotifyFailed(d); else { d.tgFails = 0; d.tgRetryAt = 0; }
}

// Переключение режима разрешений жмёт Shift+Tab по кругу и каждый раз СМОТРИТ на экран:
// Claude Code не принимает «поставь accept edits», а жать вслепую — стрельба в темноте.
const TG_MODE_MAX_STEPS = 4;         // круг короткий; больше — значит не поняли, где мы
const TG_MODE_SETTLE_MS = 220;       // TUI успевает перерисовать строку режима

// Переключение режима, общее для /mode и быстрых кнопок. Возвращает, что получилось; слова
// для человека подбирает вызывающий.
//
// Главное здесь — отказ, когда на экране запрос разрешения. Тогда строки режима нет вообще
// (внизу «Esc to cancel · Tab to amend»), а Shift+Tab уходит в сам диалог, поэтому крутить
// режим бессмысленно. И именно в этот момент человек чаще всего и пробует — потому что ему
// надоели вопросы; поэтому вместо «не разобрал режим» надо сказать, что делать.
async function tgSwitchMode(id, d, want) {
  if (parsePrompt(snapshot(d))) return { blocked: 'permission' };
  const was = readMode(snapshot(d)) || d.mode || null;
  if (was === want) return { ok: true, was, landed: was, already: true };
  let landed = was;
  for (let i = 0; i < TG_MODE_MAX_STEPS; i++) {
    const p = sessions.get(id);
    if (!p) break;
    p.write(telegram.BACK_TAB);
    await new Promise((r) => setTimeout(r, TG_MODE_SETTLE_MS));
    landed = readMode(snapshot(d)) || landed;
    if (landed === want) break;
  }
  if (landed) d.mode = landed;
  tgLog(`  режим вкладки ${id}: ${was || '?'} → ${landed || '?'} (просили ${want})`);
  return { ok: landed === want, was, landed };
}

// Нажали быструю кнопку под шапкой темы. Все действия — из тех, что и так доступны
// командами; кнопка лишь избавляет от набора текста с телефона.
// Адресат — из telegram.callbackTab: в теме его называет ТЕМА, а не payload кнопки (почему —
// написано там). Быстрой кнопке этого достаточно: она ничего не печатает в диалог и не несёт
// текста конкретного запроса, поэтому расхождение с payload — не повод отказывать, а повод
// сделать то, что написано на кнопке, с тем агентом, чью тему человек открыл.
async function tgOnAction(qa, u, ack, routed) {
  const at = telegram.callbackTab({ threadId: u.threadId, routed, payloadTab: qa.tab });
  const tab = at.tab;
  if (tab == null) {
    await ack('Эта тема ни с одной вкладкой не связана — кнопки в ней уже ничего не адресуют.'
      + ' Скажи /sync.');
    return;
  }
  if (at.mismatch) tgLog(`  кнопка из прошлого запуска: payload ${qa.tab}, тема даёт ${tab}`);
  const d = det.get(tab);
  if (!d || d.dead || !sessions.has(tab)) { await ack('Эта вкладка уже закрыта.'); return; }
  const name = tgTabName(tab);
  tgLog(`  быстрая кнопка: вкладка ${tab} → ${qa.action}`);
  if (qa.action === 'status') {
    const marks = { running: '🟠 работает', waiting: '🟡 ждёт', ready: '🟢 готов' };
    const kind = d.status === 'waiting' && d.waitingKind
      ? ` (${d.waitingKind === 'permission' ? 'разрешение' : 'вопрос'})` : '';
    await ack(`${name}: ${marks[d.status] || '⚪'}${kind}`);
    return;
  }
  if (qa.action === 'new') {
    if (!d.cwd) { await ack('Не знаю папку этой вкладки.'); return; }
    safeSend('app:createTab', { cwd: d.cwd });
    await ack('Открываю ещё одного агента в этой папке.');
    return;
  }
  // Ответы на «тему закрыли, а вкладка жива» (см. tgOnService). Вкладку закрывает рендерер —
  // тем же путём, что и крестик на самой вкладке, — а тема исчезнет следом, как при любом
  // закрытии.
  if (qa.action === 'reopen') {
    await tgTopicCall('reopenForumTopic', tgTopicOf(d));
    await ack('Тема снова открыта — пиши сюда.');
    return;
  }
  if (qa.action === 'kill') {
    safeSend('app:closeTab', { id: tab });
    await ack(`Закрываю «${name}».`);
    return;
  }
  // Режимы: то же, что /mode, но одним касанием. Ответ во всплывашке говорит, чем это
  // кончилось — включая цену «правки без спроса», чтобы нажатие не выглядело безобидным.
  const want = qa.action === 'auto' ? 'auto' : qa.action === 'edits' ? 'accept-edits' : 'manual';
  const r = await tgSwitchMode(tab, d, want);
  if (r.blocked === 'permission') {
    await ack('Сейчас открыт запрос разрешения. Ответь на него кнопкой — вариант'
      + ' «Yes, and always allow…» и есть «без спроса» для таких же дальше.');
    return;
  }
  if (r.already) { await ack(`${name}: уже «${modeTitle(want)}».`); return; }
  // Ответ через modeTitle, а не тремя ветками руками. Раньше ветки было две, и нажатие
  // «✍️ правки без спроса» отвечало «снова спрашивает разрешение» — то есть кнопка сообщала
  // ровно противоположное тому, что сделала. Подпись и ответ теперь из одного места.
  await ack(r.ok
    ? `${name}: ${modeTitle(want)}.`
    : `Не смог переключить — сейчас ${r.landed ? modeTitle(r.landed) : 'режим не разобрал'}.`);
}

// A tapped button. Everything is re-checked here, because a lot can happen between the
// message going out and your thumb landing on it: the tab may be gone, the prompt may have
// been answered at the keyboard, or a DIFFERENT prompt may now be on screen. Printing the
// number into that would be the worst thing this bridge could do — so the fingerprint of
// what's on screen right now must equal the one the button was built with.
async function tgOnCallback(u) {
  const ack = (text) => tgFetchJson(telegram.apiUrl(TG.token, 'answerCallbackQuery'),
    { callback_query_id: u.callbackId, text, show_alert: false }).catch(reportMainError);
  // Нажатие в журнал ЦЕЛИКОМ и сразу, до всех проверок: раньше писали только успешные пути, и
  // «я нажал, ничего не произошло» выглядело в журнале как отсутствие нажатия. Автор здесь
  // важнее, чем у сообщения: разрешение — самое весомое действие моста.
  tgLog(`← кнопка от ${telegram.senderLabel(u)} · thread=${u.threadId == null ? '-' : u.threadId}`
    + ` data=${JSON.stringify(String(u.data || '').slice(0, 40))}`);
  // Кого адресует нажатие, решает ТЕМА, в которой висит кнопка: тема привязана к вкладке
  // ключом, переживающим перезапуск, а номер вкладки в payload — нет (см. telegram.callbackTab).
  const routed = tgRoute(u);
  // Быстрые действия разбираются ПЕРВЫМИ и совершенно отдельно от разрешений: у них свой
  // префикс, свой обработчик и никакого отпечатка — потому что они ничего не печатают в
  // диалог. Спутать «⚡ правки без спроса» с выбором варианта в запросе разрешения было бы
  // худшим, что этот мост умеет, поэтому пути не пересекаются даже случайно.
  const qa = telegram.parseAction(u.data);
  if (qa) { await tgOnAction(qa, u, ack, routed); return; }
  const cb = telegram.parseCallbackData(u.data);
  if (!cb) { await ack('Не понял эту кнопку.'); return; }
  // Здесь расхождение с темой — ОТКАЗ, в отличие от быстрых кнопок: это сообщение несёт текст
  // запроса и отпечаток конкретной вкладки, значит при расхождении оно просто не про ту вкладку,
  // и печатать в неё номер варианта нельзя. «Тема нам неизвестна» — тоже отказ, иначе решал бы
  // один payload из прошлого запуска.
  const at = telegram.callbackTab({ threadId: u.threadId, routed, payloadTab: cb.tab });
  if (at.tab == null || at.mismatch) {
    tgLog(`  нажатие мимо: кнопка адресует вкладку ${cb.tab}, а тема ${u.threadId} —`
      + ` ${routed == null ? 'ничью' : 'вкладку ' + routed}`);
    await ack('Эта кнопка от прошлого запуска — ничего по ней не делаю.'
      + ' Скажи /sync, и запрос придёт заново.');
    return;
  }
  const tab = at.tab;
  const d = det.get(tab);
  if (!d || d.dead || !sessions.has(tab)) {
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
  tgAnswer(tab, String(cb.n));
  tgLog(`  нажатие: вкладка ${tab} → вариант ${cb.n}`);
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
  if (!tgPair) return 'Окно привязки закрыто. Открой «Настройки → Телеграм» → «Привязать группу»'
    + ' и пришли новый код.';
  const left = TG_PAIR_TTL_MS - (Date.now() - tgPair.at);
  if (left <= 0) return 'Код истёк. Нажми «Привязать группу» ещё раз и пришли новый —'
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
    // Но не бесконечно: код — единственное, что стоит между чужим человеком, нашедшим бота, и
    // привязкой к этой машине, поэтому продлеваем дважды, а дальше пусть жмут «Привязать» снова.
    if (tgPair && (tgPair.renewed || 0) < TG_PAIR_RENEW_MAX) {
      tgPair.at = Date.now();
      tgPair.renewed = (tgPair.renewed || 0) + 1;
    }
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
  tgLog(`← от ${telegram.senderLabel(u)} · chat=${u.chatId}`
    + ` thread=${u.threadId == null ? '-' : u.threadId}`
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

  // Тему тронули пальцами в самой телеге — переименовали или закрыли. Текста в таком
  // обновлении нет вовсе, поэтому разбирается оно ДО проверки «сообщение пустое», иначе
  // событие тихо выпадало бы в ту же дыру, из-за которой синк работал в одну сторону.
  if (u.service) { tgOnService(u).catch(reportMainError); return; }

  if (u.command === 'tabs') { tgSendTabs(u.threadId).catch(reportMainError); return; }
  if (u.command === 'usage') { tgUsage(u).catch(reportMainError); return; }
  if (u.command === 'sync') { tgSync(u.threadId).catch(reportMainError); return; }
  if (u.command === 'new') { tgNewTab(u).catch(reportMainError); return; }
  if (u.command === 'mode') { tgMode(u).catch(reportMainError); return; }
  if (u.command === 'start' || u.command === 'help') {
    tgSend({ threadId: u.threadId, text: [
      'Уже на связи. Каждая вкладка живёт в своей теме — пиши в тему, попадёшь в её агента.',
      '',
      '/tabs — вкладки и что у них сейчас',
      '/usage — расход: контекст вкладки, 5 часов, неделя',
      '/sync — подтянуть темы под открытые вкладки',
      '/new — ещё один агент в папке этой темы',
      '/mode — режим разрешений вкладки: manual, edits, plan, auto',
    ].join('\n') }).catch(reportMainError);
    return;
  }
  if (u.voice) { tgOnVoice(u).catch(reportMainError); return; }
  const text = String(u.text || '').trim();
  if (!text) return;

  const id = tgRoute(u);
  tgLog(`  адресат: ${id == null ? 'не определён' : 'вкладка ' + id + ' (' + tgTabName(id) + ')'}`);
  if (id == null) {
    // Отказ должен называть НАСТОЯЩУЮ причину: «это общая тема» в ответ на сообщение,
    // отправленное в тему вкладки, отправляет человека искать не ту проблему.
    const why = telegram.routeFailure(u, { topics: TG.topics });
    const text = why === 'general'
      ? 'Это общая тема — здесь я не знаю, к какому агенту обращаться. Напиши в тему нужной'
        + ' вкладки (список — /tabs) или ответь реплаем на сообщение агента.'
      : why === 'topic-closed'
        ? 'Вкладка этой темы уже закрыта, писать некому. Открытые — /tabs, а /sync приведёт'
          + ' темы в соответствие с ними.'
        : 'Эта тема ни с одной вкладкой не связана. Скажи /sync — я заново сведу темы с'
          + ' открытыми вкладками, и сюда снова можно будет писать.';
    tgLog(`  отказ: ${why}`);
    tgSend({ threadId: u.threadId, replyTo: u.messageId, text }).catch(reportMainError);
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
  tgAckSend(id, d, u).catch(reportMainError);
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
  const secs = Number(u.voice.seconds) || 0;
  if (secs > TG_VOICE_MAX_S) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `Это ${secs} с — беру голосовые до ${TG_VOICE_MAX_S} с. Скажи короче или напиши текстом.` });
    return;
  }
  const r = await tgVoiceToText(u.voice.fileId);
  if (r.error) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: r.error });
    return;
  }
  // Эхо ДО печати в сессию, и именно поэтому await: «RoseVPN» легко становится «розовым
  // пн», и увидеть, ЧТО услышано, надо раньше, чем агент по этому пойдёт работать. Если
  // сначала печатать, то в ленте порядок обратный — ответ агента раньше расшифровки.
  // Расшифровка — ОТДЕЛЬНЫМ сообщением, которое потом никто не переписывает. Так человек
  // видит своими глазами, что именно услышано («RoseVPN» или «розовый пн»), и может
  // поправить, пока агент ещё думает. Вписывать её в сообщение с ответом нельзя: длинный
  // ответ в правку не влезает (Telegram режет на 4096), и тогда расшифровка осталась бы
  // висеть рядом с вечным «думаю…».
  tgRemember(await tgSend({ threadId: u.threadId, replyTo: u.messageId,
    text: `🎙 услышал: «${r.text}»` }), id);
  await tgAckSend(id, d, u);
  const tagged = telegram.tagInput({ text: r.text, instruction: TG_PROMPT, primed: !!(d && d.tgPrimed) });
  if (!tgAnswer(id, tagged)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: 'Эта вкладка уже закрыта.' });
    return;
  }
  if (d) d.tgPrimed = true;
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

// /mode — посмотреть и переключить режим разрешений из телеги, тем же Shift+Tab, которым
// это делают за клавиатурой. Смысл: с телефона видно, что агент упёрся в разрешения на
// каждую правку, и можно разрешить их пачкой, не подходя к маку.
//
// Циклом, а не «установить режим»: Claude Code переключает режимы по кругу и не принимает
// «сделай accept edits» — поэтому жмём по одному разу и СМОТРИМ на экран, пока не попадём в
// нужный. Без чтения экрана это была бы стрельба в темноте.
// Четыре режима живого Claude Code, и auto — САМОСТОЯТЕЛЬНЫЙ, а не синоним accept edits:
// правки без спроса разрешают только правки, а auto судит каждое действие сам. Раньше
// здесь стояло auto → accept-edits, и «/mode auto» честно останавливался на «правках»,
// потому что просил не то.
//
// Псевдоним «без-вопросов» оставлен, хотя обещает лишнее: люди его уже набирали, и убрать
// его значило бы отвечать «не понял режим» на то, что вчера работало. Ответ теперь говорит
// правду про цену, а вход остаётся широким.
const TG_MODE_ALIASES = {
  auto: 'auto', авто: 'auto', автомод: 'auto', 'без-вопросов': 'auto',
  edits: 'accept-edits', 'accept-edits': 'accept-edits', правки: 'accept-edits',
  plan: 'plan', план: 'plan', планирование: 'plan',
  manual: 'manual', обычный: 'manual', normal: 'manual', ручной: 'manual',
};

function tgModeNow(d) {
  return readMode(snapshot(d));
}

async function tgMode(u) {
  const id = tgRoute(u);
  const d = id == null ? null : det.get(id);
  if (!d || !sessions.has(id)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: '/mode работает в теме вкладки — оттуда я знаю, какому агенту переключать режим.' });
    return;
  }
  const arg = String(u.text || '').replace(/^\/\S+\s*/, '').trim().toLowerCase();
  const now = tgModeNow(d);
  if (!arg) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)}: режим ${now ? modeTitle(now) : 'не разобрал'}.`
        + '\n\nЧетыре режима, по кругу Shift+Tab:'
        + '\n/mode manual — спрашивает разрешение на всё'
        + '\n/mode edits — правки без спроса, остальное спрашивает'
        + '\n/mode plan — сначала план, без изменений'
        + '\n/mode auto — сам решает; на опасном (git с потерями, удаление, деплой, секреты)'
        + ' всё равно спросит' });
    return;
  }
  const want = TG_MODE_ALIASES[arg];
  if (!want) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: 'Не понял режим. Бывают: manual (спрашивает разрешение), edits (правки без'
        + ' спроса), plan (планирование), auto (сам решает).' });
    return;
  }
  const r = await tgSwitchMode(id, d, want);
  if (r.blocked === 'permission') {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)} сейчас держит запрос разрешения, и пока он на экране режим не`
        + ' переключается: Shift+Tab уходит в сам диалог.\n\nОтветь на запрос кнопкой —'
        + ' вариант «Yes, and always allow…» и есть «без спроса» для таких же дальше. А после'
        + ' ответа /mode auto сработает.' });
    return;
  }
  if (r.already) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)} уже в режиме «${modeTitle(want)}».` });
    return;
  }
  await tgSend({ threadId: u.threadId, replyTo: u.messageId,
    text: r.ok
      ? `${tgTabName(id)}: режим «${modeTitle(want)}».`
        + (want === 'auto' ? ' На опасном (git с потерями, удаление, деплой, секреты) всё'
          + ' равно спросит — настоящая тишина только в bypass.' : '')
      : `Не смог переключить: сейчас ${r.landed ? '«' + modeTitle(r.landed) + '»' : 'режим не видно'}.`
        + ' Возможно, агент занят и строки режима на экране нет — попробуй, когда он ответит,'
        + ' или переключи за компьютером (Shift+Tab).' });
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
  // Обратная сторона: темы, чьих вкладок больше нет. Сносим — /sync означает «пусть в группе
  // будет то же, что на машине», а закрытая тема с замочком остаётся мусором в списке.
  const live = new Set();
  for (const [id, d] of det) if (!d.dead && d.tabKey && sessions.has(id)) live.add(d.tabKey);
  let gone = 0;
  for (const [key, thread] of Object.entries(TG.topics)) {
    if (live.has(key)) continue;
    await tgDeleteTopic(thread);
    gone++;
  }
  const names = [...det].filter(([id, d]) => !d.dead && sessions.has(id)).map(([id]) => tgTabName(id));
  await tgSend({ threadId, text: `Тем под открытые вкладки: ${names.length}`
    + (names.length ? ' — ' + names.join(', ') : '')
    + (gone ? `\nУбрано тем от закрытых вкладок: ${gone}` : '') });
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

// /usage — расход: контекст и два окна подписки. В теме вкладки отвечаем про неё, в
// общей теме — про все: окна подписки общие на аккаунт, а контекст у каждой свой,
// поэтому «по вкладкам» — это ответ на вопрос «кого пора сжимать».
async function tgUsage(u) {
  const id = tgRoute(u);
  const ids = id != null ? [id] : [...det].filter(([, d]) => !d.dead).map(([sid]) => sid);
  const rows = ids.map((sid) => {
    const d = det.get(sid);
    return {
      name: tgTabName(sid),
      usage: readUsage(d && d.claudeSessionId),
      // Причина важнее прочерка: своя строка статуса в команде запуска — это наш
      // осознанный отказ вмешиваться, а не поломка, и человеку это надо различать.
      why: d && d.claudeSessionId ? 'нет данных: вкладка ещё не отрисовала строку статуса'
        : 'нет данных: это не разговор Claude Code',
    };
  });
  await tgSend({ threadId: u.threadId, text: statusline.usageReport(rows, Math.floor(Date.now() / 1000)) });
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
  // Писать стало некуда — выбор «где я» вместе с чатом и уходит. Иначе он остался бы
  // втихую: кнопка без привязанной группы не показывается, и следующая привязка
  // начиналась бы с уже работающего зеркала, которого никто не просил.
  tgPresence = 'desk';
  try { fs.unlinkSync(tgPath()); } catch (_) { /* already gone */ }
  tgApplyKeepAwake();
  return tgState();
});

// Re-run the rights check on demand: the usual fix is «сделать бота админом», and the
// user needs a way to confirm it took without restarting anything.
ipcMain.handle('telegram:check', async () => {
  tgCheck = await tgCheckChat();
  try { tgSave(); } catch (e) { reportMainError(e); }   // isForum may have changed
  // Заодно поднимаем опрос, если он лежит: человек, который жмёт «проверить», хочет, чтобы
  // мост заработал, а не отчёта о том, что он всё ещё стоит.
  if (TG.token && !(tgPoller && tgPoller.alive)) await tgConnect();
  return tgState();
});

// Поднять опрос заново. Фатальная ошибка (401 «не тот токен», 409 «этот токен уже читает
// кто-то другой») гасит цикл НАСОВСЕМ — так и надо, повторы её не лечат. Но выйти из этого
// состояния было можно только перезапуском приложения: tgConnect вызывался лишь на старте и
// при сохранении токена. А 409 получить легко — запустить второй экземпляр или тот же бот на
// втором компьютере, — и мост оставался мёртвым, хотя причина уже устранена.
ipcMain.handle('telegram:reconnect', async () => {
  if (!TG.token) return tgState();
  await tgConnect();
  return tgState();
});

// The «you're answering from a phone» instruction (Telegram panel). Empty → the default.
ipcMain.handle('telegram:setPrompt', (_e, raw) => {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 400);
  TG.prompt = text;
  tgApplyPrompt();
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

// «Кратко или полностью» — какими просить агента отвечать в телегу. Своя формулировка,
// если она есть, продолжает перебивать пресет: переключатель меняет то, что подставляется
// вместо неё, а не отменяет её.
ipcMain.handle('telegram:setDetail', (_e, raw) => {
  const detail = telegram.DETAILS.includes(raw) ? raw : 'short';
  TG.detail = detail;
  tgApplyPrompt();
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

// Зеркалить итоги ВСЕГДА, а не только пока тебя нет за столом: для тех, кому телега — полный
// журнал работы, а не связь на время отсутствия. Настройка, поэтому живёт на диске — в
// отличие от выбора «где я» (см. tgPresence). Включена — «за компом» в том списке выбрать
// нельзя: человек и так получает всё, и обещать ему тишину было бы неправдой.
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

// Не давать маку уснуть, пока человека нет: с закрытой крышкой ничто не опрашивает телегу,
// и «ответить из такси» тихо перестаёт работать. Выключено = обычное поведение сна.
ipcMain.handle('telegram:setKeepAwake', (_e, on) => {
  TG.keepAwake = !!on;
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgApplyKeepAwake();
  return tgState();
});

// «Где я» — выбор из списка в строке состояния. Не сохраняется на диск (см. tgPresence):
// это положение дел на сегодня, а не настройка.
//
// Журналим каждый переход, и не ради полноты: «почему в телегу поехали итоги всех вкладок» и
// «почему не поехали» разбираются именно по этой строке, а сам выбор следов не оставляет.
const TG_PRESENCE_SAID = {
  desk: 'за компом — в группу только вопросы и разрешения',
  both: 'с обоих устройств — итоги всех ходов идут в группу',
  phone: 'за телефоном — итоги всех ходов идут в группу, мак не засыпает',
};

ipcMain.handle('telegram:setPresence', (_e, raw) => {
  const next = TG_PRESENCE.includes(raw) ? raw : 'desk';
  if (next !== tgPresence) {
    tgPresence = next;
    tgLog('где я: ' + TG_PRESENCE_SAID[next]);
    tgApplyKeepAwake();
  }
  return tgState();
});

ipcMain.handle('telegram:unpair', async () => {
  TG.chatId = null; TG.isForum = false; TG.topics = {}; tgCheck = null;
  tgPresence = 'desk';        // как и в forget: некуда зеркалить — нет и выбора
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

  // Build the launch line BEFORE the shell exists: our long flag values are handed
  // over in this shell's environment (see envPassing), so they have to be collected
  // while we can still set it.
  const pass = envPassing(shell);
  const pinned = injectSessionId(injectPermissionMode(
    injectAgentRules(injectStatusline(opts.command != null ? opts.command : START_COMMAND, pass), pass)));
  const cmd = pinned.cmd;

  const child = pty.spawn(shell, isWin ? [] : ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd,
    // <-- inherits your Claude Code auth. Do not strip. Our own SWARM_* additions carry
    // the flag values that would otherwise be echoed across half the screen.
    env: { ...process.env, ...pass.env },
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

  // Known id => exact transcript binding. Either we pinned it just now (a fresh tab),
  // or the renderer is restoring a conversation and told us the id it is resuming —
  // `--resume <id>` keeps that id, so the tab binds precisely from the first tick
  // instead of guessing by folder + mtime.
  d0.claudeSessionId = pinned.sessionId || String(opts.resumeId || '') || null;
  // Give the login shell a moment to finish sourcing the profile, then run claude —
  // preceded by a `clear`, so what the user sees first is the agent and not the line we
  // typed for them.
  if (cmd) {
    setTimeout(() => {
      const p = sessions.get(id);
      if (p) p.write(clearPrefix(shell) + cmd + '\r');
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
    // Промах по слагу — ищем шире, но найденное ПРОВЕРЯЕМ по записанной внутри папке.
    // `--resume` разрешает разговор в пределах текущей папки, поэтому файл из чужого проекта
    // — это ложное «да»: вкладка снова упирается в «сессия не найдена», то есть ровно в тот
    // тупик, от которого эта проверка и поставлена.
    const root = path.join(os.homedir(), '.claude', 'projects');
    for (const dir of fs.readdirSync(root)) {
      const full = path.join(root, dir, file);
      if (fs.existsSync(full) && sessionCwdIs(full, cwd)) return true;
    }
  } catch (_) {}
  return false;
});

// Начало файла стенограммы: и имя разговора, и папка лежат в его первых записях, поэтому
// больше читать незачем.
function sessionHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    return buf.slice(0, read).toString('utf8');
  } catch (_) { return ''; }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
}

// Этот разговор действительно про эту папку? Сравниваем с записанным внутри cwd, а не с именем
// папки-слага: слаг мы угадываем (см. transcript.projectSlug), а запись внутри точна.
//
// Первая строка не обязана быть той, где есть cwd (в начале файла бывают служебные записи —
// сводка, снимок истории файлов), поэтому идём по строкам до первой, которая его называет. Не
// нашли ни одной — отвечаем «нет»: это проверка, а не догадка.
function sessionCwdIs(file, cwd) {
  const want = String(cwd || '');
  if (!want) return false;
  for (const line of sessionHead(file).split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let d;
    try { d = JSON.parse(t); } catch (_) { continue; }   // хвост обрезан по 4 КБ — обычное дело
    if (d && typeof d.cwd === 'string') return d.cwd === want;
  }
  return false;
}

// ТОЛЬКО папка этой вкладки — и это принципиально, по двум причинам.
//
// Правильность: `--resume` разрешает разговор в пределах текущей папки, поэтому имя, найденное
// в другом проекте, — ложное «да», и вкладка снова упирается в «сессия не найдена».
//
// Цена: раньше здесь перебирались ВСЕ папки из ~/.claude/projects и читалось по 4 КБ из каждого
// файла — синхронно, в main-процессе, на каждую восстанавливаемую вкладку. У кого сорок
// проектов по двести разговоров, у того это тысячи чтений на вкладку, то есть ступор
// приложения при старте. И происходило это ровно у всех сразу — на первом запуске после
// обновления, когда у сохранённых вкладок ещё нет id разговора.
//
// Не нашли — вкладка просто стартует свежей. Это то же поведение, что и при ненайденном имени
// раньше, и оно строго лучше, чем возобновление в тупик.
ipcMain.handle('session:canResumeName', (_e, cwd, name) => {
  const want = String(name || '').trim();
  if (!/^swarm-[0-9a-z]{4,16}$/i.test(want)) return false;
  if (!cwd) return false;
  let dir;
  try { dir = projectDir(cwd); } catch (_) { return false; }
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { return false; }
  for (const n of names) {
    if (sessionHead(path.join(dir, n)).includes(`"customTitle":"${want}"`)) return true;
  }
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
  //
  // Но «за компьютером» — это ОТПРАВИЛ СООБЩЕНИЕ, а не «пошевелил чем-нибудь». Раньше режим
  // снимался на любом непустом байте, и потому его снимала мышь: Клод умеет включать отчёты о
  // мыши, и клик в терминале уходит сюда как последовательность. Человек ничего не отправлял —
  // а ответ на свой же вопрос с телефона уже не получал.
  //
  // Печать и Enter приходят разными событиями, поэтому «напечатал» помним до отправки. Enter
  // без печати сообщением не считается: он лишь досылает то, что уже лежит в поле ввода, а это
  // обычно текст из телеги, которому не хватило отправки (см. detector.keyboardEvent).
  const k = keyboardEvent(data);
  if (k.typed) d.typedAtKeyboard = true;
  if (k.submit) {
    if (d.typedAtKeyboard) tgClearMode(d);
    d.typedAtKeyboard = false;
  }
  const now = Date.now();
  if (/[\r\n]/.test(String(data || ''))) {
    // Enter: you SENT something. Don't sit out the grace window — that froze the
    // detector for INPUT_GRACE_MS right when the picture changes fastest, and left
    // lastDataAt stale so the agent's first output didn't read as «работает».
    // This is a hint, not a verdict: a quiz answers one question and paints the
    // next, and detector.js keeps «ждёт» whenever a prompt box is still on screen.
    markAnswered(d, now);
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

// --- bring the app forward ----------------------------------------------------
// Общая для двух поводов: клик по уведомлению и попытка запустить второй сворм.
function raiseWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  app.focus({ steal: true });
}

ipcMain.on('app:focus', () => raiseWindow());

// Годится ли рабочая папка второго запуска под новую вкладку.
//
// Смысл проверки в том, что папка есть НЕ ВСЕГДА: запуск из Finder или через `open` даёт
// корень файловой системы — это не проект, и открывать там агента бессмысленно. А вот запуск
// `swarm` из терминала внутри репозитория даёт именно то, что человек имел в виду.
function launchCwd(dir) {
  const p = String(dir || '');
  if (!p) return null;
  if (p === path.parse(p).root) return null;      // «/» на маке, «C:\» на винде — не проект
  try { if (!fs.statSync(p).isDirectory()) return null; } catch (_) { return null; }
  return p;
}

// Вторую копию запустить нельзя (замок выше), но САМА ПОПЫТКА — это осмысленный жест: человек
// пришёл к сворму, и чаще всего из папки, с которой хочет работать. Поэтому не молча
// поднимаем окно, а ещё и открываем в этой папке агента — тем же путём, которым это делает
// /new из телеги (вкладки умеет только рендерер, там xterm и DOM).
app.on('second-instance', (_e, _argv, workingDirectory) => {
  raiseWindow();
  const cwd = launchCwd(workingDirectory);
  if (cwd) safeSend('app:createTab', { cwd });
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
// Same shape for «просить агента звать вас»: a pref pushed on startup and on toggle.
// Nothing to write — the rule is a launch flag, so it applies to the next session.
ipcMain.on('settings:agentRules', (_e, enabled) => { AGENT_RULES = !!enabled; });
// И для «новые вкладки стартуют в режиме». Проверяем значение здесь, а не только в панели:
// сюда приходит то, что лежало в localStorage, а там мог остаться режим из версии, где он
// назывался иначе. Неизвестное — это пусто, то есть «не вмешиваться»; подставить с ним флаг
// значило бы, что вкладка вообще не запустится.
ipcMain.on('settings:permissionMode', (_e, mode) => {
  const want = String(mode || '');
  PERMISSION_MODE = modeFlag(want) ? want : '';
});

// Список режимов для селекта в настройках — ОТСЮДА, а не списком в рендерере: подписи и
// сами режимы живут в screen.js (там же, где их читают с экрана), и второй список рядом
// разошёлся бы с первым молча. Порядок — живой круг Shift+Tab, чтобы селект читался как
// то же самое, что человек видит в терминале.
//
// bypass в списке НЕТ намеренно: в круг Shift+Tab он не входит, требует отдельного согласия
// Claude Code, и вкладка, которой флаг не понравился, встречает человека мёртвой оболочкой.
// Кому нужен именно он — пишет флаг в поле флагов сам, и там его никто не перебьёт.
ipcMain.handle('settings:modes', () => {
  return ['manual', 'accept-edits', 'plan', 'auto'].map((id) => ({ id, title: modeTitle(id) }));
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
