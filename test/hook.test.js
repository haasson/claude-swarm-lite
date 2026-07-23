// End-to-end test of the shipped Claude hook: feed it an event JSON on stdin, then
// round-trip its terminalSequence through the app's own parser (osc.js) — exactly
// what happens at runtime. Runs the real script so the wiring is what ships.
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractHookSignals } = require('../osc');

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

test('Stop → idle', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Stop', session_id: 's1' }).token, 'idle');
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

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' hook tests passed');
