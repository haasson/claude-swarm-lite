#!/usr/bin/env node
// scripts/write-build-info.mjs — write build-info.json for the asar (runtimeId +
// read-only registry token). Used by release.mjs (mac) and GitLab CI (windows).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const electronVer = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version;
const nodePtyVer = JSON.parse(
  readFileSync('node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json', 'utf8')
).version;
const runtimeId = createHash('sha256').update(`${electronVer}|${nodePtyVer}`).digest('hex');
const updateToken = process.env.UPDATE_REGISTRY_TOKEN || '';
if (!updateToken) {
  console.warn('⚠ UPDATE_REGISTRY_TOKEN не задан — self-update будет выключен в этой сборке');
}
writeFileSync('build-info.json', JSON.stringify({ runtimeId, updateToken }) + '\n');
console.log(`build-info.json (runtimeId ${runtimeId.slice(0, 12)}…)`);
