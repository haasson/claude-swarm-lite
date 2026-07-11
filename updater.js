// updater.js — main-process update mechanics (fs / net / electron). Pure decisions
// live in updater-core. Fully disabled in dev (not packaged, or no build-info.json).
const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const core = require('./updater-core');

const MANIFEST_URL =
  'https://gitlab.internal/api/v4/projects/331/packages/generic/apps/latest/manifest.json';

// After a Windows deferred asar-swap, relaunch must NOT call app.relaunch() — a
// helper script starts the exe once this process has fully exited and unlocked
// app.asar. See applyAsar / scheduleWinAsarSwap.
let deferredRelaunch = false;
function consumeDeferredRelaunch() {
  const v = deferredRelaunch;
  deferredRelaunch = false;
  return v;
}

// build-info.json is bundled at the app root (inside app.asar); holds this build's
// runtimeId + the read-only registry token. Absent in dev → updater is off.
function readBuildInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8')); }
  catch (_) { return null; }
}
function enabled() { return app.isPackaged && !!readBuildInfo(); }

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: token ? { 'PRIVATE-TOKEN': token } : {} }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// Download url → destPath with optional sha256 verify + progress(percent). Deletes
// the partial file on sha mismatch.
function download(url, token, destPath, expectedSha, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: token ? { 'PRIVATE-TOKEN': token } : {} }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(destPath);
      out.on('error', reject);
      res.on('error', reject);
      res.on('data', (c) => {
        got += c.length; hash.update(c);
        if (onProgress && total) onProgress(Math.round((got / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        const sha = hash.digest('hex');
        if (expectedSha && sha !== String(expectedSha).toLowerCase()) {
          fs.unlink(destPath, () => {});
          reject(new Error('sha256 mismatch'));
          return;
        }
        resolve(destPath);
      }));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
  });
}

async function checkForUpdate() {
  if (!enabled()) return { kind: 'none' };
  const info = readBuildInfo();
  const buf = await httpGet(MANIFEST_URL, info.updateToken);
  const manifest = JSON.parse(buf.toString('utf8'));
  return core.decideUpdate(app.getVersion(), info.runtimeId, manifest);
}

function resourcesAsarPath() { return path.join(process.resourcesPath, 'app.asar'); }

function psLiteral(s) {
  // Single-quoted PowerShell string; escape embedded single quotes by doubling.
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// On Windows the running Electron process locks app.asar, so rename fails with
// EBUSY. Download the new file, then hand off to a detached PowerShell helper
// that waits for our PID to exit, swaps files, and starts the exe again.
function scheduleWinAsarSwap({ asarPath, tmpPath, bakPath }) {
  const exePath = process.execPath;
  const pid = process.pid;
  const ps1 = path.join(os.tmpdir(), `swarm-update-${pid}.ps1`);
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$targetPid = ${pid}`,
    `while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }`,
    `Start-Sleep -Milliseconds 600`,
    `$asar = ${psLiteral(asarPath)}`,
    `$tmp  = ${psLiteral(tmpPath)}`,
    `$bak  = ${psLiteral(bakPath)}`,
    `$exe  = ${psLiteral(exePath)}`,
    `if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }`,
    `Move-Item -LiteralPath $asar -Destination $bak -Force`,
    `Move-Item -LiteralPath $tmp  -Destination $asar -Force`,
    `Start-Process -FilePath $exe`,
    `Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue`,
    '',
  ].join('\r\n');
  fs.writeFileSync(ps1, script, 'utf8');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
}

// Download the new asar (verified), then swap it in with a .bak backup. Throws if
// the app dir isn't writable or the hash mismatches → renderer offers the installer.
// On Windows the swap is deferred until process exit (see scheduleWinAsarSwap);
// caller must then exit without app.relaunch() so the helper can start us.
async function applyAsar(asarUrl, sha256, onProgress) {
  if (!enabled()) throw new Error('updater disabled');
  const info = readBuildInfo();
  const asarPath = resourcesAsarPath();
  const dir = path.dirname(asarPath);
  fs.accessSync(dir, fs.constants.W_OK); // throws if not writable
  const tmp = path.join(dir, 'app.asar.new');
  try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  await download(asarUrl, info.updateToken, tmp, sha256, onProgress);
  const bak = path.join(dir, 'app.asar.bak');

  if (process.platform === 'win32') {
    scheduleWinAsarSwap({ asarPath, tmpPath: tmp, bakPath: bak });
    deferredRelaunch = true;
    return { ok: true, deferred: true };
  }

  try { fs.rmSync(bak, { force: true }); } catch (_) {}
  fs.renameSync(asarPath, bak);   // keep old for manual rollback
  fs.renameSync(tmp, asarPath);
  return { ok: true };
}

async function downloadInstaller(url, filename) {
  if (!enabled()) throw new Error('updater disabled');
  const info = readBuildInfo();
  const dest = path.join(app.getPath('downloads'), filename);
  await download(url, info.updateToken, dest, null, null);
  shell.showItemInFolder(dest);
  return { ok: true, path: dest };
}

// --- self-relocation (macOS): ensure the app lives somewhere user-writable so a
// later asar-swap works. Returns true if it kicked off relocation (caller must NOT
// open a window — we exit after copying).
function isWritable(p) { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch (_) { return false; } }

function maybeRelocate() {
  if (!app.isPackaged || process.platform !== 'darwin') return false;
  const bundle = app.getPath('exe').split('/Contents/')[0]; // .../Claude Swarm Lite.app
  const fromDmg = bundle.startsWith('/Volumes/');
  if (!fromDmg && isWritable(process.resourcesPath)) return false; // already fine
  const declinedFlag = path.join(app.getPath('userData'), 'relocate-declined');
  if (fs.existsSync(declinedFlag)) return false;
  const dest = path.join(os.homedir(), 'Applications', path.basename(bundle));
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Не сейчас', 'Переместить'],
    defaultId: 1, cancelId: 0,
    title: 'Установка',
    message: 'Переместить Claude Swarm в «Программы» (~/Applications)?',
    detail: 'Нужно для обновлений по кнопке. Приложение перезапустится из новой папки.',
  });
  if (choice !== 1) { try { fs.writeFileSync(declinedFlag, '1'); } catch (_) {} return false; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(bundle, dest, { recursive: true });
    try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dest]); } catch (_) {}
    execFileSync('/usr/bin/open', [dest]);
    app.exit(0);
    return true;
  } catch (_) {
    return false; // relocation failed — keep running from the current location
  }
}

module.exports = {
  checkForUpdate,
  applyAsar,
  downloadInstaller,
  maybeRelocate,
  enabled,
  consumeDeferredRelaunch,
};
