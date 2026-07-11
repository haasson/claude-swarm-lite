// Pure-logic tests for pty-loader (Win vs Mac asar-swap contract).
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const loader = require('../pty-loader');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('needsSpawnHelperResolvePatch: never on win32', () => {
  assert.strictEqual(loader.needsSpawnHelperResolvePatch('win32'), false);
  assert.strictEqual(loader.needsSpawnHelperResolvePatch('darwin'), true);
  assert.strictEqual(loader.needsSpawnHelperResolvePatch('linux'), true);
});

test('unpackedPtyDir points at asar.unpacked homebridge package', () => {
  const dir = loader.unpackedPtyDir('/App/Resources');
  assert.ok(dir.includes('app.asar.unpacked'));
  assert.ok(dir.endsWith(path.join('node_modules', '@homebridge', 'node-pty-prebuilt-multiarch')));
  assert.ok(!dir.includes('app.asar.unpacked.unpacked'));
});

test('without patch, node-pty rewrite yields unpacked.unpacked (the Mac bug)', () => {
  const lib = '/App/Resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch/lib';
  const helper = loader.simulateNodePtyHelperPath(lib, '/', false);
  assert.ok(helper.includes('/app.asar.unpacked.unpacked/'), helper);
  assert.ok(helper.endsWith('/build/Release/spawn-helper'), helper);
});

test('with patch, node-pty rewrite lands on real unpacked spawn-helper', () => {
  const lib = '/App/Resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch/lib';
  const helper = loader.simulateNodePtyHelperPath(lib, '/', true);
  assert.ok(!helper.includes('unpacked.unpacked'), helper);
  assert.strictEqual(
    helper,
    '/App/Resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/spawn-helper'
  );
});

test('Windows-style seps: patch still avoids double-unpacked', () => {
  // Document that the adjust helper is sep-aware (Mac uses /, but logic is shared).
  const broken = '\\App\\Resources\\app.asar.unpacked\\node_modules\\x\\build\\Release\\spawn-helper';
  const adjusted = loader.adjustSpawnHelperResolveResult(broken, '\\');
  assert.strictEqual(
    adjusted,
    '\\App\\Resources\\app.asar\\node_modules\\x\\build\\Release\\spawn-helper'
  );
  // After node-pty replace:
  assert.strictEqual(
    adjusted.replace('app.asar', 'app.asar.unpacked'),
    broken
  );
});

test('loadPty on win32: require(unpacked) only — never patches path.resolve', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pty-'));
  const unpacked = loader.unpackedPtyDir(tmp);
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'index.js'), 'module.exports = { ok: true, from: "unpacked" };');

  const before = path.resolve;
  const required = [];
  const pty = loader.loadPty({
    isPackaged: true,
    resourcesPath: tmp,
    platform: 'win32',
    requireFn: (id) => { required.push(id); return require(id); },
  });
  assert.strictEqual(pty.from, 'unpacked');
  assert.strictEqual(required.length, 1);
  assert.strictEqual(required[0], unpacked);
  assert.strictEqual(path.resolve, before, 'win32 must not wrap path.resolve');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('loadPty on win32 does not leave path.resolve patched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pty-'));
  const unpacked = loader.unpackedPtyDir(tmp);
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'index.js'), 'module.exports = { ok: true };');
  const before = path.resolve;
  loader.loadPty({
    isPackaged: true,
    resourcesPath: tmp,
    platform: 'win32',
    requireFn: (id) => require(id),
  });
  assert.strictEqual(path.resolve, before);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('loadPty on darwin restores path.resolve after require', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pty-'));
  const unpacked = loader.unpackedPtyDir(tmp);
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'index.js'), 'module.exports = { ok: true };');
  const before = path.resolve;
  loader.loadPty({
    isPackaged: true,
    resourcesPath: tmp,
    platform: 'darwin',
    requireFn: (id) => require(id),
  });
  assert.strictEqual(path.resolve, before);
  fs.rmSync(tmp, { recursive: true, force: true });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
