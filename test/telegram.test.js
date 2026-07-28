// Plain-node tests for the Telegram protocol layer (telegram.js). No network: the
// poller takes its fetch and its sleep as dependencies, so the loop — offsets, backoff,
// fatal errors — is pinned here rather than discovered in production.
const assert = require('assert');
const T = require('../telegram');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const TOKEN = '123456789:AAHfake_token_value_that_is_long_enough_x';

// --- token -------------------------------------------------------------------

test('looksLikeToken accepts what BotFather gives out', () => {
  assert.strictEqual(T.looksLikeToken(TOKEN), true);
  assert.strictEqual(T.looksLikeToken('  ' + TOKEN + '  '), true, 'trims');
});

test('looksLikeToken rejects the usual paste accidents', () => {
  assert.strictEqual(T.looksLikeToken(''), false);
  assert.strictEqual(T.looksLikeToken('123456789'), false, 'no secret half');
  assert.strictEqual(T.looksLikeToken('123456789:short'), false, 'truncated copy');
  assert.strictEqual(T.looksLikeToken('Use this token to access the HTTP API:'), false);
  assert.strictEqual(T.looksLikeToken(null), false);
});

test('maskToken keeps the bot id and hides the secret', () => {
  const m = T.maskToken(TOKEN);
  assert.ok(m.startsWith('123456789:'), m);
  assert.ok(!m.includes('fake_token_value'), 'the secret must not survive masking');
  assert.strictEqual(T.maskToken('nonsense'), '');
});

// --- pairing -----------------------------------------------------------------

test('pairCode has no lookalike characters', () => {
  const code = T.pairCode();
  assert.strictEqual(code.length, T.CODE_LEN);
  assert.ok(!/[01OIL]/.test(code), 'ambiguous glyph in ' + code);
});

test('deepLink builds a start link, and a startgroup one for a supergroup', () => {
  assert.strictEqual(T.deepLink('@myswarmbot', 'AB23CD'), 'https://t.me/myswarmbot?start=AB23CD');
  assert.strictEqual(T.deepLink('myswarmbot', 'AB23CD', { group: true }),
    'https://t.me/myswarmbot?startgroup=AB23CD');
});

test('pairingMatch accepts /start with the code, in private and in a group', () => {
  assert.strictEqual(T.pairingMatch({ text: '/start AB23CD' }, 'AB23CD'), true);
  assert.strictEqual(T.pairingMatch({ text: '/start@myswarmbot AB23CD' }, 'AB23CD'), true);
  assert.strictEqual(T.pairingMatch({ text: 'ab23cd' }, 'AB23CD'), true, 'typed by hand, any case');
});

test('pairingMatch rejects a wrong or missing code', () => {
  assert.strictEqual(T.pairingMatch({ text: '/start' }, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch({ text: '/start WRONG1' }, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch({ text: 'AB23CD extra words' }, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch(null, 'AB23CD'), false);
  assert.strictEqual(T.pairingMatch({ text: 'AB23CD' }, ''), false);
});

// --- updates -----------------------------------------------------------------

const msgUpdate = (over) => ({
  update_id: 10,
  message: Object.assign({
    message_id: 5,
    from: { id: 42, first_name: 'Женя' },
    chat: { id: -100123, type: 'supergroup', is_forum: true },
    text: 'да, вариант 2',
  }, over),
});

test('readUpdate pulls out chat, author, text and the reply key', () => {
  const u = T.readUpdate(msgUpdate({ reply_to_message: { message_id: 77 } }));
  assert.strictEqual(u.kind, 'message');
  assert.strictEqual(u.chatId, -100123);
  assert.strictEqual(u.fromId, 42);
  assert.strictEqual(u.text, 'да, вариант 2');
  assert.strictEqual(u.replyToId, 77, 'the reply is the routing key');
  assert.strictEqual(u.isForum, true);
});

test('readUpdate reports a forum topic only for a topic message', () => {
  assert.strictEqual(T.readUpdate(msgUpdate({ is_topic_message: true, message_thread_id: 9 })).threadId, 9);
  assert.strictEqual(T.readUpdate(msgUpdate({ message_thread_id: 9 })).threadId, null);
});

test('readUpdate parses a command with and without arguments', () => {
  assert.deepStrictEqual(
    (({ command, args }) => ({ command, args }))(T.readUpdate(msgUpdate({ text: '/start AB23CD' }))),
    { command: 'start', args: 'AB23CD' });
  assert.strictEqual(T.readUpdate(msgUpdate({ text: '/tabs' })).command, 'tabs');
  assert.strictEqual(T.readUpdate(msgUpdate({ text: 'не команда' })).command, null);
});

test('readUpdate carries a voice note through (phase two transcribes it)', () => {
  const u = T.readUpdate(msgUpdate({ text: undefined, voice: { file_id: 'f1', duration: 3 } }));
  assert.deepStrictEqual(u.voice, { fileId: 'f1', seconds: 3 });
});

test('readUpdate survives junk and non-message updates', () => {
  assert.strictEqual(T.readUpdate(null), null);
  assert.strictEqual(T.readUpdate({ update_id: 1, poll: {} }).kind, 'other');
});

// --- outbound text -----------------------------------------------------------

test('chunkText leaves a short message alone', () => {
  assert.deepStrictEqual(T.chunkText('коротко'), ['коротко']);
  assert.deepStrictEqual(T.chunkText(''), []);
});

test('chunkText splits on a paragraph boundary when it can', () => {
  const parts = T.chunkText('a'.repeat(30) + '\n\n' + 'b'.repeat(30), 40);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts[0], 'a'.repeat(30));
  assert.strictEqual(parts[1], 'b'.repeat(30));
});

test('chunkText never exceeds the cap, even with no break to use', () => {
  for (const p of T.chunkText('я'.repeat(200), 40)) assert.ok(p.length <= 40, p.length);
});

// --- retry pacing ------------------------------------------------------------

test('backoff grows and is capped', () => {
  assert.ok(T.backoffMs(0) < T.backoffMs(3));
  assert.strictEqual(T.backoffMs(99), T.BACKOFF_MAX_MS);
});

test("Telegram's own retry_after wins over our backoff", () => {
  assert.strictEqual(T.retryAfterMs({ parameters: { retry_after: 7 } }), 7000);
  assert.strictEqual(T.retryAfterMs({}), 0);
});

test('classifyError: a bad token and a rival poller are terminal, network is not', () => {
  assert.strictEqual(T.classifyError(401, {}).fatal, true);
  assert.strictEqual(T.classifyError(409, {}).reason, 'conflict');
  assert.strictEqual(T.classifyError(409, {}).fatal, true);
  assert.strictEqual(T.classifyError(0, {}).fatal, false);
  assert.strictEqual(T.classifyError(429, {}).fatal, false);
});

// --- the poll loop -----------------------------------------------------------
// A fake fetch replays scripted responses; `sleep` records what the loop asked to wait
// instead of actually waiting, and stops the loop once the script runs out.

function harness(script) {
  const calls = [];
  const seen = [];
  const states = [];
  const slept = [];
  let i = 0;
  const poller = T.createPoller({
    token: TOKEN,
    fetchJson: async (url, body) => {
      calls.push({ url, body });
      const step = script[i++];
      if (!step) { poller.stop(); return { ok: true, status: 200, body: { ok: true, result: [] } }; }
      if (step.throw) throw new Error(step.throw);
      return step;
    },
    sleep: async (ms) => { slept.push(ms); },
    onUpdate: (u) => seen.push(u),
    onState: (s) => states.push(s),
  });
  return { poller, calls, seen, states, slept };
}

const okUpdates = (result) => ({ ok: true, status: 200, body: { ok: true, result } });

test('poller advances the offset past every update it handled', async () => {
  const h = harness([okUpdates([msgUpdate({}), { update_id: 11, message: msgUpdate({}).message }])]);
  await h.poller.start();
  assert.strictEqual(h.seen.length, 2);
  assert.strictEqual(h.poller.offset, 12, 'offset must be last update_id + 1');
  assert.strictEqual(h.calls[1].body.offset, 12, 'and be sent on the next poll');
});

test('poller keeps going when a handler throws (the update is not replayed)', async () => {
  const calls = [];
  let i = 0;
  const script = [okUpdates([msgUpdate({})])];
  const poller = T.createPoller({
    token: TOKEN,
    fetchJson: async (url, body) => {
      calls.push(body);
      const step = script[i++];
      if (!step) { poller.stop(); return okUpdates([]); }
      return step;
    },
    sleep: async () => {},
    onUpdate: () => { throw new Error('handler exploded'); },
  });
  await poller.start();
  assert.strictEqual(calls[1].offset, 11, 'moved on despite the throw');
});

test('poller stops for good on a fatal error (bad token)', async () => {
  const h = harness([{ ok: false, status: 401, body: { ok: false, description: 'Unauthorized' } }]);
  await h.poller.start();
  assert.strictEqual(h.calls.length, 1, 'no retry after a fatal error');
  assert.strictEqual(h.states[0].error.reason, 'unauthorized');
  assert.strictEqual(h.poller.alive, false);
});

test('poller backs off on a network failure and comes back', async () => {
  const h = harness([{ throw: 'ENOTFOUND api.telegram.org' }, okUpdates([])]);
  await h.poller.start();
  assert.ok(h.slept[0] >= 1000, 'waited before retrying: ' + h.slept[0]);
  assert.strictEqual(h.states[0].error.reason, 'network');
  assert.ok(h.calls.length >= 2, 'retried');
});

test('poller reports recovery once, not on every successful poll', async () => {
  const h = harness([{ throw: 'offline' }, okUpdates([]), okUpdates([])]);
  await h.poller.start();
  const recoveries = h.states.filter((s) => s.ok === true && !s.handlerError);
  assert.strictEqual(recoveries.length, 1, JSON.stringify(h.states));
});

test('poller obeys retry_after on a flood wait', async () => {
  const h = harness([{ ok: false, status: 429, body: { ok: false, parameters: { retry_after: 3 } } }, okUpdates([])]);
  await h.poller.start();
  assert.strictEqual(h.slept[0], 3000);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' telegram tests passed');
})();
