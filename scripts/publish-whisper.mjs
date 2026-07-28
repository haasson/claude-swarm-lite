#!/usr/bin/env node
// scripts/publish-whisper.mjs — выложить сборки whisper.cpp в реестр, откуда их берёт
// кнопка «Включить голосовые».
//
// Запуск:  node scripts/publish-whisper.mjs [версия]      (по умолчанию 1.9.1)
// Нужно:   GITLAB_TOKEN с scope `api`; на macOS — cmake (brew install cmake) и Xcode CLT.
// Итог:    файлы в apps/whisper-<версия>/*, манифест в apps/latest/whisper.json.
//
// Почему так, а не вложить бинарник в приложение: обновления ходят свопом app.asar, и
// вложенный распознаватель дорожал бы каждое обновление ВСЕМ, включая тех, кому голос не
// нужен. Поэтому он лежит в реестре и качается только по нажатию кнопки.
//
// Почему манифест, а не константы в voice.js: новую версию whisper.cpp можно выложить, не
// выпуская версию приложения — приложение читает манифест и берёт то, что там описано.
//
// macOS: готового CLI в релизах whisper.cpp нет, собираем сами — статически
// (BUILD_SHARED_LIBS=OFF), с встроенными шейдерами Metal (GGML_METAL_EMBED_LIBRARY=ON),
// иначе бинарник ищет .metal рядом с собой и молча остаётся на CPU. Результат зависит
// только от системных фреймворков — проверяется через otool.
// Windows: берём официальный whisper-bin-x64.zip. Кладём ВСЕ ggml-cpu-*.dll: ggml выбирает
// подходящий под процессор в рантайме, и «не нашёл бэкенд» у пользователя дороже 6 МБ.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = process.argv[2] || '1.9.1';
const HOST = 'gitlab.internal';
const BASE = `https://${HOST}/api/v4/projects/331/packages/generic/apps`;
const ZIP = `https://github.com/ggml-org/whisper.cpp/releases/download/v${VERSION}/whisper-bin-x64.zip`;
const WIN_KEEP = ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll'];

const token = process.env.GITLAB_TOKEN;
if (!token) fail('нужен GITLAB_TOKEN с scope api');
if (process.platform !== 'darwin') fail('mac-бинарник собирается только на macOS');

function fail(m) { console.error('✗ ' + m); process.exit(1); }
function step(m) { console.log('▸ ' + m); }
function sh(cmd, args, opts) { execFileSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {})); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-pub-'));
const pub = path.join(work, 'pub');
fs.mkdirSync(pub);

// --- macOS: собрать -----------------------------------------------------------
step(`клонирую whisper.cpp v${VERSION}`);
const src = path.join(work, 'src');
sh('git', ['clone', '--depth', '1', '--branch', `v${VERSION}`, 'https://github.com/ggml-org/whisper.cpp.git', src]);
step('собираю whisper-cli (статически, Metal внутри)');
sh('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF', '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DCMAKE_OSX_ARCHITECTURES=arm64'], { cwd: src });
sh('cmake', ['--build', 'build', '--config', 'Release', '--target', 'whisper-cli', '-j8'], { cwd: src });
const built = path.join(src, 'build', 'bin', 'whisper-cli');
if (!fs.existsSync(built)) fail('whisper-cli не собрался');
// Ни одной посторонней динамической библиотеки: иначе на чужой машине он не запустится.
const libs = execFileSync('otool', ['-L', built], { encoding: 'utf8' }).split('\n').slice(1)
  .map((l) => l.trim().split(' ')[0]).filter(Boolean)
  .filter((l) => !l.startsWith('/System/') && !l.startsWith('/usr/lib/'));
if (libs.length) fail('бинарник тянет посторонние библиотеки: ' + libs.join(', '));
fs.copyFileSync(built, path.join(pub, 'whisper-cli'));
fs.chmodSync(path.join(pub, 'whisper-cli'), 0o755);

// --- Windows: взять готовое ---------------------------------------------------
step('качаю официальный whisper-bin-x64.zip');
const zip = path.join(work, 'w.zip');
sh('curl', ['-sL', '-o', zip, ZIP]);
sh('unzip', ['-j', '-o', zip, ...WIN_KEEP.map((n) => `Release/${n}`), 'Release/ggml-cpu-*.dll',
  '-d', pub], { stdio: 'ignore' });
const winFiles = [...WIN_KEEP, ...fs.readdirSync(pub).filter((f) => f.startsWith('ggml-cpu-')).sort()];
for (const n of winFiles) if (!fs.existsSync(path.join(pub, n))) fail('в архиве нет ' + n);

// --- манифест -----------------------------------------------------------------
const entry = (name) => {
  const b = fs.readFileSync(path.join(pub, name));
  return { name, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
};
const manifest = {
  version: VERSION,
  note: `whisper.cpp v${VERSION} — mac собран статически (Metal встроен), win из официального релиза`,
  runtimes: {
    'darwin-arm64': { bin: 'whisper-cli', files: [entry('whisper-cli')] },
    'win32-x64': { bin: 'whisper-cli.exe', files: winFiles.map(entry) },
  },
};
for (const [k, v] of Object.entries(manifest.runtimes)) {
  step(`${k}: ${v.files.length} файлов, ${(v.files.reduce((s, f) => s + f.bytes, 0) / 1e6).toFixed(1)} МБ`);
}

// --- выложить -----------------------------------------------------------------
async function put(url, body) {
  const res = await fetch(url, { method: 'PUT', headers: { 'PRIVATE-TOKEN': token }, body });
  if (!res.ok) fail(`${url} → HTTP ${res.status} ${await res.text()}`);
}
for (const name of fs.readdirSync(pub)) {
  step(`выкладываю ${name}`);
  await put(`${BASE}/whisper-${VERSION}/${name}`, fs.readFileSync(path.join(pub, name)));
}
// Манифест — последним: пока он не обновлён, приложения продолжают брать прошлую версию,
// а не половину выложенной новой.
await put(`${BASE}/latest/whisper.json`, JSON.stringify(manifest, null, 2) + '\n');
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n✔ whisper.cpp ${VERSION} выложен. Кнопка «Включить голосовые» берёт его отсюда.`);
