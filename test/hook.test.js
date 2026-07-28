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

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' hook tests passed');
