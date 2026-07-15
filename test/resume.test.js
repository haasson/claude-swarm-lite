// Plain-node tests for Claude session pin/resume helpers.
const assert = require('assert');
const R = require('../renderer/resume');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('supports Claude family stems', () => {
  assert.strictEqual(R.supports('claude'), true);
  assert.strictEqual(R.supports('Claude'), true);
  assert.strictEqual(R.supports('cld'), true);
  assert.strictEqual(R.supports('claude-glm'), true);
  assert.strictEqual(R.supports('/usr/local/bin/claude'), true);
  assert.strictEqual(R.supports('codex'), false);
  assert.strictEqual(R.supports('gemini'), false);
  assert.strictEqual(R.supports('glm'), false);
});

test('newSessionKey is swarm- + 8 hex', () => {
  const k = R.newSessionKey();
  assert.match(k, /^swarm-[0-9a-f]{8}$/);
  assert.notStrictEqual(R.newSessionKey(), R.newSessionKey());
});

test('stripSessionFlags drops continue/resume/name', () => {
  assert.strictEqual(
    R.stripSessionFlags('--dangerously-skip-permissions --continue --model sonnet'),
    '--dangerously-skip-permissions --model sonnet'
  );
  assert.strictEqual(
    R.stripSessionFlags('-c --resume abc -n old --foo'),
    '--foo'
  );
  assert.strictEqual(
    R.stripSessionFlags('--resume=abc --name=old -r'),
    ''
  );
  assert.strictEqual(R.stripSessionFlags('-r uuid --keep'), '--keep');
});

test('buildCommand start pins Claude with -n', () => {
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude', flags: '', sessionKey: 'swarm-deadbeef', mode: 'start' }),
    'claude -n swarm-deadbeef'
  );
  assert.strictEqual(
    R.buildCommand({
      cmd: 'cld',
      flags: '--dangerously-skip-permissions --resume junk',
      sessionKey: 'swarm-aa',
      mode: 'start',
    }),
    'cld --dangerously-skip-permissions -n swarm-aa'
  );
});

test('buildCommand resume uses --resume key', () => {
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude-glm', flags: '--model opus', sessionKey: 'swarm-01', mode: 'resume' }),
    'claude-glm --model opus --resume swarm-01'
  );
});

test('buildCommand leaves non-Claude alone', () => {
  assert.strictEqual(
    R.buildCommand({ cmd: 'codex', flags: '--foo', sessionKey: 'swarm-01', mode: 'resume' }),
    'codex --foo'
  );
  assert.strictEqual(
    R.buildCommand({ cmd: 'claude', flags: '--x', sessionKey: null, mode: 'start' }),
    'claude --x'
  );
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok —', name);
    } catch (err) {
      console.error('FAIL —', name);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
