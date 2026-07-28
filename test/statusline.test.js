// Plain-node tests for the statusline renderer (swarm-statusline.js).
//
// The subscription budget is the part worth pinning down: it comes from Claude Code
// and is OPTIONAL, so every «absent» path has to render nothing rather than a
// misleading zero — and the limit percentages must never reach the line before the
// context one, because the app parses the first % as the context fill.
const assert = require('assert');
const { renderLine, renderLimits, usedPct, fmtEta } = require('../swarm-statusline');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = 1_700_000_000;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A statusline payload with a context window (so the context bar renders) and,
// optionally, the subscription limits.
function payload(rateLimits) {
  return {
    model: { display_name: 'Opus 5' },
    workspace: { current_dir: '/tmp/some-project' },
    session_id: 'no-such-session',
    context_window: { remaining_percentage: 80, total_tokens: 1_000_000 },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  };
}

test('reports what is SPENT, the same direction as the site', () => {
  assert.strictEqual(usedPct({ used_percentage: 37 }), 37);
  assert.strictEqual(usedPct({ used_percentage: 0 }), 0);
});

test('rounds spend UP so it never reports less than has gone', () => {
  assert.strictEqual(usedPct({ used_percentage: 0.4 }), 1, 'a sliver spent is not nothing spent');
  assert.strictEqual(usedPct({ used_percentage: 62.1 }), 63);
});

test('a missing or non-numeric percentage yields no number at all', () => {
  assert.strictEqual(usedPct(undefined), null);
  assert.strictEqual(usedPct({}), null);
  assert.strictEqual(usedPct({ used_percentage: '37' }), null);
  assert.strictEqual(usedPct({ used_percentage: NaN }), null);
});

test('clamps a percentage outside 0..100', () => {
  assert.strictEqual(usedPct({ used_percentage: 140 }), 100);
  assert.strictEqual(usedPct({ used_percentage: -20 }), 0);
});

test('formats the reset countdown coarsely, by the largest two units', () => {
  assert.strictEqual(fmtEta(8040), '2ч14м');
  assert.strictEqual(fmtEta(1080), '18м');
  assert.strictEqual(fmtEta(273600), '3д4ч');
  assert.strictEqual(fmtEta(7200), '2ч');
  assert.strictEqual(fmtEta(172800), '2д');
  assert.strictEqual(fmtEta(-5), '0м', 'a reset already due is not negative time');
});

test('renders both windows as spent percentages, verbatim from the payload', () => {
  const out = strip(renderLimits({
    five_hour: { used_percentage: 37, resets_at: NOW + 3600 },
    seven_day: { used_percentage: 62, resets_at: NOW + 86400 },
  }, NOW));
  assert.match(out, /5ч 37%/);
  assert.match(out, /7д 62%/);
});

test('hides the reset countdown while the window is still comfortable', () => {
  const out = strip(renderLimits({ five_hour: { used_percentage: 37, resets_at: NOW + 3600 } }, NOW));
  assert.strictEqual(out.includes('↻'), false);
});

test('shows the reset countdown once the window is nearly spent', () => {
  const out = strip(renderLimits({ five_hour: { used_percentage: 90, resets_at: NOW + 8040 } }, NOW));
  assert.match(out, /5ч 90%.*↻2ч14м/);
});

test('marks a nearly-spent window with a glyph, not colour alone', () => {
  // The app reads this line with ANSI stripped, so colour cannot carry state.
  const out = strip(renderLimits({ five_hour: { used_percentage: 95, resets_at: NOW + 600 } }, NOW));
  assert.match(out, /⚠/);
});

test('a barely-touched window carries neither the glyph nor a countdown', () => {
  const out = strip(renderLimits({ five_hour: { used_percentage: 11, resets_at: NOW + 9720 } }, NOW));
  assert.strictEqual(out.includes('⚠'), false);
  assert.strictEqual(out.includes('↻'), false);
  assert.match(out, /5ч 11%/);
});

test('renders nothing when the limits are absent — no bare 0%', () => {
  // No rate_limits at all: an API-key account, or before the first API response.
  assert.strictEqual(renderLimits(undefined, NOW), '');
  assert.strictEqual(renderLimits(null, NOW), '');
  assert.strictEqual(renderLimits({}, NOW), '');
});

test('renders the window it has when only one of the two is reported', () => {
  const out = strip(renderLimits({ five_hour: { used_percentage: 20 } }, NOW));
  assert.match(out, /5ч 20%/);
  assert.strictEqual(out.includes('7д'), false);
});

test('a past reset time drops the countdown instead of counting backwards', () => {
  const out = strip(renderLimits({ five_hour: { used_percentage: 95, resets_at: NOW - 60 } }, NOW));
  assert.match(out, /5ч 95%/);
  assert.strictEqual(out.includes('↻'), false);
});

test('the context percentage stays the first % in the line', () => {
  // Load-bearing: the app takes the first % as the context fill (renderer updateCtx).
  const line = strip(renderLine(payload({
    five_hour: { used_percentage: 37 },
    seven_day: { used_percentage: 62 },
  }), NOW));
  const first = line.match(/(\d+)\s*%/);
  assert.ok(first, 'the line carries a percentage');
  // 24% used: 80% of the window left, rescaled against the usable region (the
  // window minus the auto-compact buffer). Notably neither 37 nor 62 — the limits.
  assert.strictEqual(first[1], '24', 'the context fill, not a limit');
});

test('limits are withheld when there is no context bar to follow', () => {
  // Without the context bar a limit % would be parsed AS the context fill.
  const data = payload({ five_hour: { used_percentage: 37 } });
  data.context_window = { remaining_percentage: null };
  const line = strip(renderLine(data, NOW));
  assert.strictEqual(line.includes('5ч'), false);
  assert.strictEqual(line.includes('%'), false);
});

test('the line still renders without limits at all', () => {
  const line = strip(renderLine(payload(), NOW));
  assert.match(line, /Opus 5 │ some-project/);
  assert.match(line, /24%/);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' statusline tests passed');
