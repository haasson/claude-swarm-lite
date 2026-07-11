#!/usr/bin/env node
// Strip platform-native binaries out of app.asar before publishing the
// cross-platform in-app update payload.
//
// electron-builder's asarUnpack copies natives to app.asar.unpacked BUT also
// leaves them inside app.asar. A Mac-built asar then contains darwin pty.node
// under build/Release/. On Windows, require('../build/Release/conpty.node')
// resolves inside that asar directory, misses conpty (Mac never had it), and
// never falls through to the install's app.asar.unpacked — empty window after
// asar-swap. Removing build/ + prebuilds/ from the published asar fixes it:
// each OS keeps using its own unpacked natives from the full installer.
import { createRequire } from 'node:module';
import { existsSync, rmSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const asarPath = process.argv[2];
if (!asarPath || !existsSync(asarPath)) {
  console.error('usage: node scripts/strip-asar-natives.mjs <app.asar>');
  process.exit(1);
}

const staging = mkdtempSync(path.join(tmpdir(), 'swarm-asar-strip-'));
try {
  asar.extractAll(asarPath, staging);
  const ptyRoot = path.join(
    staging,
    'node_modules',
    '@homebridge',
    'node-pty-prebuilt-multiarch'
  );
  for (const rel of ['build', 'prebuilds']) {
    rmSync(path.join(ptyRoot, rel), { recursive: true, force: true });
  }
  const out = asarPath + '.stripped';
  await asar.createPackage(staging, out);
  renameSync(out, asarPath);
  console.log('stripped natives from', asarPath);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
