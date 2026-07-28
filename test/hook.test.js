// End-to-end test of the shipped Claude hook: feed it an event JSON on stdin, then
// round-trip its terminalSequence through the app's own parser (osc.js) — exactly
// what happens at runtime. Runs the real script so the wiring is what ships.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const { extractHookSignals } = require('../osc');
const { DEFAULT_SOURCES, phraseSources } = require('../ask-phrases');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const SCRIPT = path.join(__dirname, '..', 'hooks', 'swarm-signal.mjs');

// The hook is ESM; its pure helpers are imported once below and used as H.*. Importing it
// does NOT run it — main() is gated on being invoked directly.
let H = null;

// Run the hook with `payload` on stdin; return the parsed signal (or null if the
// hook emitted nothing), by feeding its terminalSequence back through osc.js.
function runHook(payload) {
  const out = execFileSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (!out.trim()) return null;
  const seq = JSON.parse(out).terminalSequence;
  const { signals } = extractHookSignals(seq);
  return signals[0] || null;
}

test('UserPromptSubmit → busy', () => {
  assert.deepStrictEqual(runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'abc' }),
    { token: 'busy', sessionId: 'abc' });
});

test('Stop with nothing to say → idle', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Stop', session_id: 's1' }).token, 'idle');
});

// The whole point of reading last_assistant_message: a turn that ENDED and a turn
// that ended WITH A QUESTION are the same event, so the closing text decides.
test('Stop whose last message calls the user → ask', () => {
  const p = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Готово.\n\nСейчас от тебя: путь к схеме' };
  assert.strictEqual(runHook(p).token, 'ask');
});

test('Stop with «Сейчас от тебя: ничего, жди …» → idle (not a question)', () => {
  const p = { hook_event_name: 'Stop', last_assistant_message: 'Сейчас от тебя: ничего, жди результата' };
  assert.strictEqual(runHook(p).token, 'idle');
});

test('PostToolUse → busy (the approved tool finished, work resumed)', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }).token, 'busy');
});

test('Notification agent_needs_input → ask', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }).token, 'ask');
});

test('PermissionRequest → perm', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 's1' }).token, 'perm');
});

test('Notification permission_prompt → perm', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).token, 'perm');
});

test('Notification idle_prompt → idle', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).token, 'idle');
});

test('PreToolUse AskUserQuestion → ask', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 'q' }).token, 'ask');
});

test('PreToolUse for a normal tool → busy', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }).token, 'busy');
});

test('an event we do not care about emits nothing', () => {
  assert.strictEqual(runHook({ hook_event_name: 'SessionStart' }), null);
});

test('a generic Notification (no type) emits nothing', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification' }), null);
});

// --- the user's own call phrases ---------------------------------------------
// The app compiles them (ask-phrases.js) into swarm-phrases.json next to the script.
// Here we stage a copy of the hook with such a file and check it picks it up.

test('the hook fallback phrases are exactly ask-phrases.js defaults', () => {
  const code = `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => console.log(JSON.stringify(m.FALLBACK)))`;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out), DEFAULT_SOURCES);
});

test('a custom phrase file replaces the default marker', () => {
  // realpath: on macOS os.tmpdir() is the /var → /private/var symlink, and the
  // script's «am I being run directly?» check compares import.meta.url (resolved)
  // with argv[1] (not) — through the symlink it would never run main().
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  const phrases = ['Твой ход (важно)'];
  fs.writeFileSync(path.join(dir, 'swarm-phrases.json'),
    JSON.stringify(Object.assign({ phrases }, phraseSources(phrases))));
  const run = (msg) => {
    const out = execFileSync(process.execPath, [staged], {
      input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: msg }),
      encoding: 'utf8',
    });
    return extractHookSignals(JSON.parse(out).terminalSequence).signals[0].token;
  };
  assert.strictEqual(run('Всё готово. Твой ход (важно)'), 'ask', 'the user phrase must call');
  assert.strictEqual(run('Готово. Сейчас от тебя: путь'), 'idle', 'the default no longer applies');
  assert.strictEqual(run('Твой ход (важно): ничего, жди'), 'idle', 'the «ничего/жди» rule still holds');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- last_assistant_message comes in more than one shape ----------------------

test('messageText unwraps a string, an object and content blocks alike', () => {
  assert.strictEqual(H.messageText('готово'), 'готово');
  assert.strictEqual(H.messageText({ type: 'text', text: 'готово' }), 'готово');
  assert.strictEqual(H.messageText({ content: [{ type: 'text', text: 'готово' }] }), 'готово');
  assert.strictEqual(H.messageText([{ type: 'text', text: 'а' }, { type: 'text', text: 'б' }]), 'а\nб');
  assert.strictEqual(H.messageText(null), '');
  assert.strictEqual(H.messageText({ nope: 1 }), '', 'no text anywhere → empty, never "[object Object]"');
});

test('the call phrase is found in an OBJECT last_assistant_message', () => {
  const m = H.loadMatcher(() => null);   // shipped default
  assert.strictEqual(H.callsUser(m, { type: 'text', text: 'Сейчас от тебя: путь' }), true);
  assert.strictEqual(H.tokenFor({ hook_event_name: 'Stop', last_assistant_message: { type: 'text', text: 'Сейчас от тебя: путь' } }, m), 'ask');
});

// --- refusing the interactive picker while driven from Telegram ----------------

test('deniesPicker only fires for AskUserQuestion in a listed session', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' };
  assert.strictEqual(H.deniesPicker(ask, ['s1']), true);
  assert.strictEqual(H.deniesPicker(ask, ['other']), false, 'another tab is not affected');
  assert.strictEqual(H.deniesPicker(ask, []), false);
  assert.strictEqual(H.deniesPicker({ ...ask, tool_name: 'Bash' }, ['s1']), false, 'only the picker');
  assert.strictEqual(H.deniesPicker({ ...ask, session_id: '' }, ['']), false, 'no session id, no deny');
});

test('the deny payload carries the status marker AND the decision', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, ['s1']);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(/Telegram/.test(out.hookSpecificOutput.permissionDecisionReason));
  assert.ok(out.terminalSequence, 'status must still be reported while denying');
});

test('without Telegram mode the payload is exactly what it was before', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, []);
  assert.deepStrictEqual(Object.keys(out), ['terminalSequence']);
});

test('an event we do not care about still produces nothing', () => {
  const m = H.loadMatcher(() => null);
  assert.strictEqual(H.outputFor({ hook_event_name: 'SessionStart' }, m, ['s1']), null);
});

test('end to end: the script denies the picker for a session listed on disk', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-tg-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  fs.writeFileSync(path.join(dir, 'swarm-tgmode.json'), JSON.stringify({ sessions: ['sid-1'] }));
  const run = (sid) => JSON.parse(execFileSync(process.execPath, [staged], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: sid }),
    encoding: 'utf8',
  }));
  assert.strictEqual(run('sid-1').hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(run('sid-2').hookSpecificOutput, undefined, 'a tab at the keyboard keeps its picker');
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  H = await import(pathToFileURL(SCRIPT).href);
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' hook tests passed');
})();
