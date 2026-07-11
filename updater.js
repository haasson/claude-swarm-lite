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

// After a deferred asar-swap (Windows / macOS), relaunch must NOT call
// app.relaunch() — a helper script starts the app once this process has fully
// exited and unlocked app.asar. See applyAsar / schedule*AsarSwap.
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

function shLiteral(s) {
  // Single-quoted POSIX string; escape embedded single quotes as '\'' .
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// On Windows the running Electron process locks app.asar, so rename fails with
// EBUSY. Download the new file, then hand off to a PowerShell helper that waits
// for our PID to exit, swaps files, and starts the exe again.
//
// Critical: Chromium puts children in a Job Object with KILL_ON_JOB_CLOSE.
// `spawn(..., { detached: true })` does NOT break out of that job, so a plain
// detached powershell dies the moment we `app.exit` — app closes, never
// relaunches, version stays old. Launch via `cmd /c start "" /b ...` so the
// helper is a job-breakaway process that outlives us.
//
// UTF-8 BOM on the .ps1 so PowerShell 5.1 reads Cyrillic install paths.
// Retries the rename: Chromium child processes can hold the lock after main exits.
function scheduleWinAsarSwap({ asarPath, tmpPath, bakPath }) {
  const exePath = process.execPath;
  const pid = process.pid;
  const logPath = path.join(os.tmpdir(), `swarm-update-${pid}.log`);
  const ps1 = path.join(os.tmpdir(), `swarm-update-${pid}.ps1`);
  const cmd = path.join(os.tmpdir(), `swarm-update-${pid}.cmd`);
  const script = [
    `$targetPid = ${pid}`,
    `while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }`,
    `Start-Sleep -Milliseconds 1000`,
    `$asar = ${psLiteral(asarPath)}`,
    `$tmp  = ${psLiteral(tmpPath)}`,
    `$bak  = ${psLiteral(bakPath)}`,
    `$exe  = ${psLiteral(exePath)}`,
    `$log  = ${psLiteral(logPath)}`,
    `$ok = $false`,
    `$lastErr = ''`,
    `for ($i = 0; $i -lt 120; $i++) {`,
    `  try {`,
    `    if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }`,
    `    Move-Item -LiteralPath $asar -Destination $bak -Force`,
    `    Move-Item -LiteralPath $tmp  -Destination $asar -Force`,
    `    $ok = $true`,
    `    break`,
    `  } catch {`,
    `    $lastErr = $_.Exception.Message`,
    `    Start-Sleep -Milliseconds 500`,
    `  }`,
    `}`,
    `try { ("ok=$ok err=$lastErr") | Out-File -FilePath $log -Encoding utf8 } catch {}`,
    `if (-not $ok) {`,
    `  try {`,
    `    if (-not (Test-Path -LiteralPath $asar) -and (Test-Path -LiteralPath $bak)) {`,
    `      Move-Item -LiteralPath $bak -Destination $asar -Force`,
    `    }`,
    `  } catch {}`,
    `}`,
    `Start-Process -FilePath $exe`,
    `Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
    '',
  ].join('\r\n');
  fs.writeFileSync(ps1, '\uFEFF' + script, 'utf8');

  const psExe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  // Tiny trampoline: `start` creates a process outside Electron's job object.
  // Quote paths for cmd.exe; empty title ("") is required when the command is quoted.
  const bat = [
    '@echo off',
    `start "" /b "${psExe}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}"`,
    `del "%~f0" >nul 2>&1`,
    '',
  ].join('\r\n');
  fs.writeFileSync(cmd, bat, 'utf8');

  return new Promise((resolve, reject) => {
    // Wait for cmd to finish (start returns immediately after launching PS) so
    // the helper is alive before we exit.
    const child = spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/c', cmd],
      { stdio: 'ignore', windowsHide: true }
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('helper launch failed: ' + code));
    });
  });
}

// On macOS, renaming app.asar under a live Electron process invalidates its
// memory mapping and often SIGBUS's during quit — macOS then shows
// "unexpectedly quit" even though relaunch succeeds. Defer the swap until
// after a clean exit, same idea as Windows.
function scheduleDarwinAsarSwap({ asarPath, tmpPath, bakPath }) {
  const exePath = process.execPath;
  const bundle = exePath.split('/Contents/')[0]; // .../Claude Swarm Lite.app
  const pid = process.pid;
  const scriptPath = path.join(os.tmpdir(), `swarm-update-${pid}.sh`);
  const script = [
    '#!/bin/sh',
    `pid=${pid}`,
    `asar=${shLiteral(asarPath)}`,
    `tmp=${shLiteral(tmpPath)}`,
    `bak=${shLiteral(bakPath)}`,
    `bundle=${shLiteral(bundle)}`,
    `exe=${shLiteral(exePath)}`,
    `self=${shLiteral(scriptPath)}`,
    'while kill -0 "$pid" 2>/dev/null; do sleep 0.4; done',
    'sleep 1',
    'rm -f "$bak"',
    'if mv "$asar" "$bak" && mv "$tmp" "$asar"; then',
    '  :',
    'else',
    '  # Best-effort restore if we moved asar away but failed to put the new one.',
    '  if [ ! -e "$asar" ] && [ -e "$bak" ]; then mv "$bak" "$asar"; fi',
    'fi',
    'if [ -d "$bundle" ]; then',
    '  /usr/bin/open "$bundle"',
    'else',
    '  "$exe" &',
    'fi',
    'rm -f "$self"',
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// Download the new asar (verified), then swap it in with a .bak backup. Throws if
// the app dir isn't writable or the hash mismatches → renderer offers the installer.
// On Windows / macOS the swap is deferred until process exit (see schedule*AsarSwap);
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
    await scheduleWinAsarSwap({ asarPath, tmpPath: tmp, bakPath: bak });
    deferredRelaunch = true;
    return { ok: true, deferred: true };
  }

  if (process.platform === 'darwin') {
    await scheduleDarwinAsarSwap({ asarPath, tmpPath: tmp, bakPath: bak });
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
