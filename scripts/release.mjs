#!/usr/bin/env node
// scripts/release.mjs — cut a release and publish it to GitLab.
//
// Usage:  npm run release -- patch|minor|major       (default: patch)
// Needs:  GITLAB_TOKEN  — a GitLab PAT with `api` scope, in the environment.
// Run on: macOS (this builds the .dmg locally; GitLab has no macOS runner).
//
// What it does, in order:
//   1. sanity: clean tree, on `main`, token present
//   2. bump version in package.json
//   3. prepend a CHANGELOG.md section from commits since the last tag
//   4. refresh the download links block in README.md
//   5. commit "release: vX.Y.Z" + annotated tag vX.Y.Z (tag message = changelog)
//   6. build the .dmg  (npm run dist)
//   7. upload the .dmg to the GitLab generic package registry
//   8. push main + the tag
//
// Pushing the tag triggers .gitlab-ci.yml, which builds the Windows .exe on a
// Linux+Wine runner, uploads it next to the .dmg, and creates the GitLab Release
// linking both. So this script owns the Mac half; CI owns the Windows half.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const HOST = 'gitlab.internal';
const PROJECT_ID = 331;
const PKG = 'apps'; // generic-package name; download path is /packages/generic/apps/<version>/<file>

const token = process.env.GITLAB_TOKEN;
if (!token) fail('set GITLAB_TOKEN (a GitLab PAT with `api` scope) before running');

const bump = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) fail('argument must be patch | minor | major');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function step(msg) { console.log('▸ ' + msg); }
function sh(cmd, args) { execFileSync(cmd, args, { stdio: 'inherit' }); }

// 1. sanity ------------------------------------------------------------------
if (git(['status', '--porcelain'])) fail('working tree is not clean — commit or stash first');
if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail("switch to the 'main' branch first");

// 2. bump --------------------------------------------------------------------
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
const version = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
step(`version ${pkg.version} → ${version}`);
pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// 3. changelog ---------------------------------------------------------------
let lastTag = '';
try { lastTag = git(['describe', '--tags', '--abbrev=0']); } catch { /* first release */ }
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const commits = git(['log', range, '--no-merges', '--pretty=- %s']) || '- начальный релиз';
const today = new Date().toISOString().slice(0, 10);
const entry = `## ${version} — ${today}\n\n${commits}\n`;
const clHeader = '# Changelog\n\n';
let clBody = '';
try { clBody = readFileSync('CHANGELOG.md', 'utf8').replace(/^# Changelog\s*/, ''); } catch { /* new file */ }
writeFileSync('CHANGELOG.md', clHeader + entry + '\n' + clBody.replace(/^\n+/, ''));
step('CHANGELOG.md updated');

// 4. README download links ---------------------------------------------------
const dmgFile = `claude-swarm-lite-${version}-arm64.dmg`;
const exeFile = `claude-swarm-lite-${version}-x64.exe`;
const base = `https://${HOST}/api/v4/projects/${PROJECT_ID}/packages/generic/${PKG}/${version}`;
const dl = [
  '<!--DL-->',
  `**Последняя версия: ${version}** · [все релизы](https://${HOST}/ai-public/claude-swarm-lite/-/releases)`,
  '',
  `- **macOS** (Apple Silicon): [\`${dmgFile}\`](${base}/${dmgFile})`,
  `- **Windows**: [\`${exeFile}\`](${base}/${exeFile}) — собирается в CI после тега`,
  '',
  '> Ссылки ведут в приватный GitLab — нужен доступ к репозиторию.',
  '<!--/DL-->',
].join('\n');
let readme = readFileSync('README.md', 'utf8');
readme = readme.includes('<!--DL-->')
  ? readme.replace(/<!--DL-->[\s\S]*?<!--\/DL-->/, dl)
  : readme.replace(/\n## /, `\n## Скачать\n\n${dl}\n\n## `); // insert before the first section
writeFileSync('README.md', readme);
step('README.md download links updated');

// 5. commit + tag ------------------------------------------------------------
sh('git', ['add', 'package.json', 'CHANGELOG.md', 'README.md']);
sh('git', ['commit', '-m', `release: v${version}`]);
sh('git', ['tag', '-a', `v${version}`, '-m', entry.trim()]);
step(`committed + tagged v${version}`);

// 6. build the dmg -----------------------------------------------------------
// electron-builder re-verifies the Electron dist against GitHub on every build;
// when GitHub's asset CDN is slow that download times out even though the zip is
// already cached. If we find the cached zip, hand it to electron-builder via
// electronDist so the build never touches the network for Electron.
function cachedElectronDist() {
  try {
    const ver = readFileSync('node_modules/electron/dist/version', 'utf8').trim();
    const zip = `electron-v${ver}-darwin-${process.arch}.zip`;
    const root = path.join(os.homedir(), 'Library', 'Caches', 'electron');
    for (const d of readdirSync(root)) {
      if (existsSync(path.join(root, d, zip))) return path.join(root, d);
    }
  } catch { /* no cache — fall back to a normal download */ }
  return null;
}
// build-info.json — this build's runtimeId + read-only registry token, bundled into
// the asar. runtimeId = sha256(electronVersion|nodePtyVersion); if it changes between
// releases, app.asar isn't swap-safe and a full installer is required.
const electronVer = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version;
const nodePtyVer = JSON.parse(readFileSync('node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json', 'utf8')).version;
const runtimeId = createHash('sha256').update(`${electronVer}|${nodePtyVer}`).digest('hex');
const updateToken = process.env.UPDATE_REGISTRY_TOKEN || '';
if (!updateToken) console.warn('⚠ UPDATE_REGISTRY_TOKEN не задан — self-update будет выключен в этой сборке');
writeFileSync('build-info.json', JSON.stringify({ runtimeId, updateToken }) + '\n');
step(`build-info.json (runtimeId ${runtimeId.slice(0, 12)}…)`);
step('building .dmg (npm run dist) …');
const distDir = cachedElectronDist();
if (distDir) step(`using cached Electron (offline-safe): ${distDir}`);
sh('npm', distDir ? ['run', 'dist', '--', `-c.electronDist=${distDir}`] : ['run', 'dist']);
const dmg = readdirSync('dist').find((f) => f === dmgFile) || readdirSync('dist').find((f) => f.endsWith('.dmg'));
if (!dmg) fail('no .dmg found in dist/ after build');

// 7. upload the dmg to the generic package registry --------------------------
step(`uploading ${dmg} to the package registry …`);
const bytes = readFileSync(path.join('dist', dmg));
const put = await fetch(`${base}/${dmgFile}`, {
  method: 'PUT',
  headers: { 'PRIVATE-TOKEN': token },
  body: bytes,
});
if (!put.ok) fail(`dmg upload failed: ${put.status} ${await put.text()}`);
step('dmg uploaded');

// Publish the platform-independent app.asar + a stable manifest for the in-app updater.
const asarPath = path.join('dist', 'mac-arm64', 'Claude Swarm Lite.app', 'Contents', 'Resources', 'app.asar');
if (!existsSync(asarPath)) fail('app.asar not found at ' + asarPath);
const asarBytes = readFileSync(asarPath);
const asarSha = createHash('sha256').update(asarBytes).digest('hex');
step(`uploading app.asar (${(asarBytes.length / 1e6).toFixed(1)} MB) …`);
const asarPut = await fetch(`${base}/app.asar`, {
  method: 'PUT', headers: { 'PRIVATE-TOKEN': token }, body: asarBytes,
});
if (!asarPut.ok) fail(`asar upload failed: ${asarPut.status} ${await asarPut.text()}`);

// Notes = the changelog section we just generated for this version.
const manifest = {
  version,
  runtimeId,
  asar: { url: `${base}/app.asar`, sha256: asarSha },
  installers: {
    dmg: `${base}/${dmgFile}`,
    exe: `${base}/claude-swarm-lite-${version}-x64.exe`,
  },
  notes: commits,
  pubDate: today,
};
const latestBase = `https://${HOST}/api/v4/projects/${PROJECT_ID}/packages/generic/${PKG}/latest`;
const manPut = await fetch(`${latestBase}/manifest.json`, {
  method: 'PUT', headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
  body: JSON.stringify(manifest, null, 2),
});
if (!manPut.ok) fail(`manifest upload failed: ${manPut.status} ${await manPut.text()}`);
step('app.asar + manifest.json published');

// 8. push --------------------------------------------------------------------
step('pushing main + tag …');
const authed = `https://oauth2:${token}@${HOST}/ai-public/claude-swarm-lite.git`;
sh('git', ['push', authed, 'main']);
sh('git', ['push', authed, `v${version}`]);

console.log(`\n✔ v${version} released. Windows .exe + GitLab Release are being built by CI:`);
console.log(`  https://${HOST}/ai-public/claude-swarm-lite/-/pipelines`);
