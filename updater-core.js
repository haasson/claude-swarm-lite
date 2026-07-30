// updater-core.js — pure update logic (no fs/net/electron), unit-tested.
'use strict';
const crypto = require('crypto');

// Compare two "x.y.z" versions → -1 | 0 | 1 (numeric per-segment).
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Runtime fingerprint: if this changes between releases, app.asar is NOT swap-safe
// (Electron or a native dep moved) and a full installer is required.
function computeRuntimeId(electronVersion, nodePtyVersion) {
  return crypto.createHash('sha256').update(`${electronVersion}|${nodePtyVersion}`).digest('hex');
}

// Сколько раз согласны пойти за Location, прежде чем считать это петлёй.
const MAX_REDIRECTS = 5;

// Куда идти дальше, глядя на ответ. Чистое решение — сама сеть в updater.js.
//
// Зачем вообще: гитхаб на скачивание ассета отвечает 302 — сначала
// releases/latest/download/… → releases/download/<тег>/…, потом ещё раз на CDN, —
// а `https.get` за Location сам не ходит. Реестр гитлаба отдавал 200 сразу, поэтому
// пока жили на нём, этого кода не требовалось, и его отсутствие ничем не проявлялось.
//
// Location по стандарту может быть относительным, поэтому разрешаем его от текущего
// адреса, а не подставляем как есть.
function nextHop(statusCode, location, url, count, max) {
  const limit = typeof max === 'number' ? max : MAX_REDIRECTS;
  if (statusCode >= 300 && statusCode < 400) {
    if (!location) return { kind: 'fail', message: `HTTP ${statusCode} без Location` };
    if (count >= limit) return { kind: 'fail', message: `слишком много редиректов (>${limit})` };
    let next;
    try { next = new URL(location, url).toString(); }
    catch (_) { return { kind: 'fail', message: 'битый Location: ' + location }; }
    return { kind: 'follow', url: next };
  }
  if (statusCode !== 200) return { kind: 'fail', message: 'HTTP ' + statusCode };
  return { kind: 'ok' };
}

function validateManifest(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('manifest is not an object');
  if (typeof obj.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(obj.version)) throw new Error('bad version');
  if (typeof obj.runtimeId !== 'string' || !obj.runtimeId) throw new Error('missing runtimeId');
  if (!obj.asar || typeof obj.asar.url !== 'string' || typeof obj.asar.sha256 !== 'string') {
    throw new Error('missing asar url/sha256');
  }
  return {
    version: obj.version,
    runtimeId: obj.runtimeId,
    asar: { url: obj.asar.url, sha256: obj.asar.sha256.toLowerCase() },
    installers: (obj.installers && typeof obj.installers === 'object') ? obj.installers : {},
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    pubDate: typeof obj.pubDate === 'string' ? obj.pubDate : '',
  };
}

// Decide what an installed (version, runtimeId) should do given a fetched manifest.
function decideUpdate(installedVersion, installedRuntimeId, manifest) {
  const m = validateManifest(manifest);
  if (compareVersions(m.version, installedVersion) <= 0) {
    return { kind: 'none', version: m.version, notes: m.notes };
  }
  const kind = m.runtimeId === installedRuntimeId ? 'asar' : 'installer';
  return { kind, version: m.version, notes: m.notes, asar: m.asar, installers: m.installers };
}

module.exports = {
  compareVersions, computeRuntimeId, validateManifest, decideUpdate, nextHop, MAX_REDIRECTS,
};
