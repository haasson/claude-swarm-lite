#!/usr/bin/env node
// scripts/write-build-info.mjs — write build-info.json for the asar (runtimeId).
// Used by release.mjs (mac) and GitHub Actions (windows).
//
// Токена здесь больше нет: релизы публичные, качаются без учётных данных. Заодно ушла
// грабля «собрал без UPDATE_REGISTRY_TOKEN → сборка тихо уехала с выключенным
// автообновлением». Сам файл по-прежнему обязателен — на его наличии держится
// enabled() в updater.js, то есть выключенная обновлялка в dev.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const electronVer = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version;
const nodePtyVer = JSON.parse(
  readFileSync('node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json', 'utf8')
).version;
const runtimeId = createHash('sha256').update(`${electronVer}|${nodePtyVer}`).digest('hex');
writeFileSync('build-info.json', JSON.stringify({ runtimeId }) + '\n');
console.log(`build-info.json (runtimeId ${runtimeId.slice(0, 12)}…)`);
