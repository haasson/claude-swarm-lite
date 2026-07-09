// Pure-logic tests for the updater (no fs/net). Run: node test/updater.test.js
const assert = require('assert');
const core = require('../updater-core');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const RID = core.computeRuntimeId('29.4.6', '0.13.1'); // a stable id for tests

function manifest(over) {
  return Object.assign({
    version: '0.4.0',
    runtimeId: RID,
    asar: { url: 'https://x/app.asar', sha256: 'ABCD' },
    installers: { dmg: 'https://x/a.dmg', exe: 'https://x/a.exe' },
    notes: 'note', pubDate: '2026-07-09',
  }, over || {});
}

test('compareVersions orders semver', () => {
  assert.strictEqual(core.compareVersions('0.4.0', '0.3.9'), 1);
  assert.strictEqual(core.compareVersions('0.3.0', '0.3.1'), -1);
  assert.strictEqual(core.compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(core.compareVersions('0.10.0', '0.9.0'), 1); // numeric, not lexical
});

test('computeRuntimeId is deterministic and input-sensitive', () => {
  assert.strictEqual(core.computeRuntimeId('29.4.6', '0.13.1'), core.computeRuntimeId('29.4.6', '0.13.1'));
  assert.notStrictEqual(core.computeRuntimeId('29.4.6', '0.13.1'), core.computeRuntimeId('30.0.0', '0.13.1'));
});

test('validateManifest normalizes and lowercases sha', () => {
  const m = core.validateManifest(manifest());
  assert.strictEqual(m.asar.sha256, 'abcd');
  assert.strictEqual(m.version, '0.4.0');
});

test('validateManifest throws on bad input', () => {
  assert.throws(() => core.validateManifest(null));
  assert.throws(() => core.validateManifest(manifest({ version: 'x' })));
  assert.throws(() => core.validateManifest(manifest({ asar: { url: 'u' } }))); // no sha256
});

test('decideUpdate: none when not newer', () => {
  assert.strictEqual(core.decideUpdate('0.4.0', RID, manifest()).kind, 'none');
  assert.strictEqual(core.decideUpdate('0.5.0', RID, manifest()).kind, 'none');
});

test('decideUpdate: asar when newer and runtimeId matches', () => {
  const d = core.decideUpdate('0.3.0', RID, manifest());
  assert.strictEqual(d.kind, 'asar');
  assert.strictEqual(d.version, '0.4.0');
  assert.strictEqual(d.asar.sha256, 'abcd');
});

test('decideUpdate: installer when newer but runtimeId differs', () => {
  const d = core.decideUpdate('0.3.0', 'DIFFERENT', manifest());
  assert.strictEqual(d.kind, 'installer');
  assert.ok(d.installers.dmg);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
