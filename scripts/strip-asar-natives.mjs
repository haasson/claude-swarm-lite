#!/usr/bin/env node
// Remove @homebridge/node-pty-prebuilt-multiarch from app.asar before publishing
// the cross-platform in-app update payload.
//
// Natives must stay in each install's app.asar.unpacked (from the full
// installer). main.js loads pty from that unpacked path when packaged. Keeping
// any copy of the package inside the swapped asar makes require resolve there
// and break Windows (no conpty.node in a Mac-built tree).
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
  rmSync(
    path.join(staging, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
    { recursive: true, force: true }
  );
  // Drop empty @homebridge dir if nothing else remains.
  const hb = path.join(staging, 'node_modules', '@homebridge');
  try {
    if (existsSync(hb) && require('fs').readdirSync(hb).length === 0) rmSync(hb);
  } catch (_) { /* ignore */ }
  const out = asarPath + '.stripped';
  await asar.createPackage(staging, out);
  renameSync(out, asarPath);
  console.log('removed node-pty from', asarPath);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
