// Contract test: every file the main process loads at runtime MUST be listed in
// package.json > build.files. Catches the class of bug where a new module is
// added at the repo root, works fine via `npm start`, and is then left out of
// the packaged asar — so the built app dies on MODULE_NOT_FOUND before the
// window ever opens (that is exactly how screen.js broke 0.8.0).
// Run: node test/package-files.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const patterns = pkg.build.files;

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Does build.files cover this repo-relative path? Patterns here are either
// plain file names ("main.js") or directory globs ("renderer/**/*").
function covered(rel) {
  return patterns.some((p) => {
    if (p === rel) return true;
    const glob = p.indexOf('*');
    return glob !== -1 && rel.startsWith(p.slice(0, glob));
  });
}

// Resolve a relative require the way Node does: exact file, then + '.js'.
function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

// Walk requires transitively from the packaged entry points. main.js is the
// electron entry; preload.js is loaded into the renderer by absolute path.
const ENTRIES = [pkg.main, 'preload.js'].map((f) => path.join(root, f));
const seen = new Set();
const reachable = [];
const unresolved = [];
const queue = [...ENTRIES];
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  reachable.push(path.relative(root, file));
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const dep = resolveLocal(file, m[1]);
    if (dep) queue.push(dep);
    else unresolved.push(`${path.relative(root, file)} -> ${m[1]}`);
  }
}

// Files loaded by path rather than by require, e.g.
// fs.copyFileSync(path.join(__dirname, 'swarm-statusline.js'), ...).
const runtimePaths = new Set();
for (const rel of reachable) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const m of src.matchAll(/__dirname\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/g)) {
    const segs = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1]);
    const p = segs.join('/');
    if (fs.existsSync(path.join(root, p))) runtimePaths.add(p);
  }
}

test('every require()d local module is listed in build.files', () => {
  const missing = reachable.filter((f) => !covered(f)).sort();
  assert.deepStrictEqual(
    missing, [],
    'these modules load at startup but are not packaged: ' + missing.join(', '),
  );
});

test('every file opened via path.join(__dirname, ...) is listed in build.files', () => {
  const missing = [...runtimePaths].filter((f) => !covered(f)).sort();
  assert.deepStrictEqual(
    missing, [],
    'these runtime assets are not packaged: ' + missing.join(', '),
  );
});

// index.html pulls its scripts by relative src, and one of them now climbs OUT of
// renderer/ (../ask-phrases.js, shared with main). Same failure mode as an unpackaged
// require, but silent: the window opens and one feature is just dead.
test('every <script src> in index.html resolves and is packaged', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const bad = [];
  for (const m of html.matchAll(/<script\s+src=["']([^"']+)["']/g)) {
    const rel = path.relative(root, path.resolve(path.join(root, 'renderer'), m[1]));
    if (!fs.existsSync(path.join(root, rel))) bad.push(m[1] + ' (missing on disk)');
    else if (!covered(rel)) bad.push(m[1] + ' (not in build.files)');
  }
  assert.deepStrictEqual(bad, [], 'broken script tags: ' + bad.join(', '));
});

test('all local requires resolve on disk', () => {
  assert.deepStrictEqual(unresolved, [], 'unresolvable requires: ' + unresolved.join(', '));
});

test('the walk actually reached the known modules (sanity)', () => {
  for (const f of ['main.js', 'preload.js', 'git.js', 'screen.js']) {
    assert.ok(reachable.includes(f), `require walk never reached ${f} — regex likely broke`);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
