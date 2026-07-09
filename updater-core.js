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

module.exports = { compareVersions, computeRuntimeId, validateManifest, decideUpdate };
