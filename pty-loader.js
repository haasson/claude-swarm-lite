// pty-loader.js — load @homebridge/node-pty-prebuilt-multiarch for a packaged
// Electron app after cross-platform asar-swap.
//
// Contract (do not break either side):
//   • Windows: require ONLY from app.asar.unpacked. Never patch path.resolve.
//     The published asar has no node-pty (strip-asar-natives); Win natives
//     (conpty.node) live in the installer's unpacked tree.
//   • macOS/Linux: also require from unpacked, but node-pty's unixTerminal.js
//     does helperPath.replace('app.asar', 'app.asar.unpacked'). If __dirname is
//     already under app.asar.unpacked, that becomes ...unpacked.unpacked and
//     posix_spawnp fails. While requiring, make path.resolve pretend the module
//     lives under app.asar so the rewrite lands on the real spawn-helper.
//
// Pure helpers are unit-tested; loadPty() is the only side-effecting API.

'use strict';

const path = require('path');
const fs = require('fs');

const PTY_PKG = path.join('@homebridge', 'node-pty-prebuilt-multiarch');

function unpackedPtyDir(resourcesPath) {
  return path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', PTY_PKG);
}

/** Win must never patch path.resolve — keep this as a pure predicate for tests. */
function needsSpawnHelperResolvePatch(platform) {
  return platform !== 'win32';
}

/**
 * Undo the double-unpacked trap before node-pty's replace() runs:
 *   resolve(.../app.asar.unpacked/.../spawn-helper)
 *     → map to .../app.asar/.../spawn-helper
 *     → replace('app.asar','app.asar.unpacked')
 *     → real helper path again
 */
function adjustSpawnHelperResolveResult(resolved, sep) {
  const from = `${sep}app.asar.unpacked${sep}`;
  const to = `${sep}app.asar${sep}`;
  if (!resolved.includes(from)) return resolved;
  return resolved.replace(from, to);
}

/** Simulate node-pty unixTerminal helperPath computation (for tests). */
function simulateNodePtyHelperPath(moduleLibDir, sep, applyPatch) {
  let resolved = moduleLibDir.replace(/[/\\]+$/, '') + sep +
    '..' + sep + 'build' + sep + 'Release' + sep + 'spawn-helper';
  // Normalize .. segments without pulling in platform path.resolve.
  const parts = resolved.split(/[/\\]/);
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  resolved = out.join(sep);
  if (applyPatch) resolved = adjustSpawnHelperResolveResult(resolved, sep);
  return resolved.replace('app.asar', 'app.asar.unpacked');
}

function requireWithSpawnHelperPatch(unpackedDir, requireFn) {
  const req = requireFn || require;
  const origResolve = path.resolve;
  path.resolve = function (...args) {
    let result = origResolve.apply(this, args);
    const last = args[args.length - 1];
    if (
      typeof last === 'string' &&
      last.includes('spawn-helper') &&
      result.includes(`${path.sep}app.asar.unpacked${path.sep}`)
    ) {
      result = adjustSpawnHelperResolveResult(result, path.sep);
    }
    return result;
  };
  try {
    return req(unpackedDir);
  } finally {
    path.resolve = origResolve;
  }
}

/**
 * @param {{ isPackaged: boolean, resourcesPath: string, platform?: string, requireFn?: Function }} opts
 */
function loadPty(opts) {
  const platform = opts.platform || process.platform;
  const req = opts.requireFn || require;
  if (opts.isPackaged) {
    const unpacked = unpackedPtyDir(opts.resourcesPath);
    if (fs.existsSync(unpacked)) {
      // Windows: plain require from unpacked — identical to the 0.6.19 fix.
      // No path.resolve patch. Ever.
      if (!needsSpawnHelperResolvePatch(platform)) return req(unpacked);
      return requireWithSpawnHelperPatch(unpacked, req);
    }
  }
  return req('@homebridge/node-pty-prebuilt-multiarch');
}

module.exports = {
  loadPty,
  unpackedPtyDir,
  needsSpawnHelperResolvePatch,
  adjustSpawnHelperResolveResult,
  simulateNodePtyHelperPath,
  PTY_PKG,
};
