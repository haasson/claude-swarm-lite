// Contract test: every window.swarm.<method> the renderer calls MUST be exposed
// by preload.js. Catches the class of bug where renderer code references a bridge
// method that preload doesn't define — which throws at load and kills the whole UI
// (no listeners get attached). Run: node test/preload-contract.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Top-level swarm methods the renderer invokes (window.swarm.<name>...).
const called = new Set(
  [...renderer.matchAll(/window\.swarm\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]),
);
// Keys exposed by preload (top-level of the exposeInMainWorld object + nested).
// A superset is fine: we only assert that every called name appears somewhere.
const defined = new Set(
  [...preload.matchAll(/^\s*([a-zA-Z_$][\w$]*)\s*:/gm)].map((m) => m[1]),
);

test('every window.swarm.<method> called in renderer is exposed by preload', () => {
  const missing = [...called].filter((n) => !defined.has(n)).sort();
  assert.deepStrictEqual(
    missing, [],
    'renderer calls window.swarm methods preload does not expose: ' + missing.join(', '),
  );
});

test('renderer actually calls at least a handful of swarm methods (sanity)', () => {
  assert.ok(called.size >= 8, `only found ${called.size} swarm calls — regex likely broke`);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
