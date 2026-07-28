'use strict';
// Голос из телеги → текст. Чистая часть: сборка WAV, поиск бинарника, аргументы и разбор
// вывода. Ввод-вывод и запуск процесса — в main.js, поэтому всё это тестируется в node.
//
// РЕШЕНИЕ, определяющее весь модуль: распознаём ЛОКАЛЬНО (whisper.cpp). Звук — это твои
// задачи вслух, и отправлять их на чужой сервер ради удобства мы отказались там же, где
// отказались от общего бота.
//
// Второе решение: НЕ тащим ffmpeg. Телеграм отдаёт OGG/Opus, whisper ест WAV 16 кГц —
// обычно тут появляется ffmpeg с отдельной инструкцией на каждую ОС. Но Chromium умеет
// декодировать Opus сам, поэтому декодирование живёт в рендерере (OfflineAudioContext),
// а здесь мы только упаковываем полученные сэмплы в WAV. Ни нативных модулей, ни
// сторонних бинарников, кроме самого whisper.

const SAMPLE_RATE = 16000;   // whisper.cpp работает только с этим

// 16-битный моно WAV из Float32 (то, что отдаёт Web Audio). Заголовок 44 байта, всё
// остальное — сэмплы; клиппинг обязателен, иначе громкая запись даёт треск.
function wavFromFloat32(samples, rate) {
  const src = samples || [];
  const n = src.length;
  const hz = rate || SAMPLE_RATE;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);          // размер fmt-блока
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // моно
  buf.writeUInt32LE(hz, 24);
  buf.writeUInt32LE(hz * 2, 28);      // байт в секунду
  buf.writeUInt16LE(2, 32);           // байт на кадр
  buf.writeUInt16LE(16, 34);          // бит на сэмпл
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, src[i] || 0));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

// Имена, под которыми whisper.cpp попадает в PATH. Их несколько, потому что проект
// переименовывал бинарник (main → whisper-cli), а brew и релизы под Windows кладут разные.
const BIN_NAMES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];

// Найти бинарник: сначала явный путь из настроек, потом PATH. `exists` инжектится, чтобы
// тест не зависел от того, что стоит на машине.
function findBinary(opts) {
  const o = opts || {};
  const exists = typeof o.exists === 'function' ? o.exists : () => false;
  const sep = o.isWin ? ';' : ':';
  const exts = o.isWin ? ['.exe', ''] : [''];
  if (o.configured) {
    for (const ext of exts) if (exists(o.configured + ext)) return o.configured + ext;
    return null;   // указали руками и промахнулись — не подменяем тихо чем-то из PATH
  }
  for (const dir of String(o.pathEnv || '').split(sep).filter(Boolean)) {
    for (const name of BIN_NAMES) {
      for (const ext of exts) {
        const full = (o.join || ((a, b) => a + '/' + b))(dir, name + ext);
        if (exists(full)) return full;
      }
    }
  }
  return null;
}

// `-nt` — без таймкодов, `-l ru` — язык не угадываем (на короткой фразе угадывается плохо),
// `-np` — не печатать прогресс в stdout, чтобы разбор не ловил мусор.
function whisperArgs(opts) {
  const o = opts || {};
  return ['-m', o.model, '-f', o.wav, '-l', o.lang || 'ru', '-nt', '-np'];
}

// Вывод whisper-cli: либо чистые строки текста (с -nt), либо со таймкодами, если версия
// их всё равно печатает. Служебные строки (whisper_init…, system_info) отбрасываем.
function parseOutput(stdout) {
  const lines = String(stdout == null ? '' : stdout).split('\n');
  const out = [];
  for (const raw of lines) {
    let t = raw.trim();
    if (!t) continue;
    if (/^(whisper_|system_info|main:|ggml_)/i.test(t)) continue;
    t = t.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, '');   // таймкод, если он есть
    if (!t || t === '[BLANK_AUDIO]' || /^\(.*\)$/.test(t)) continue;
    out.push(t);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Что показать в настройках, когда голос не настроен: инструкция своя на каждую ОС,
// потому что brew есть только на маке.
function setupHint(platform) {
  if (platform === 'win32') {
    return 'Windows: скачайте готовый whisper.cpp из его релизов на GitHub, распакуйте и'
      + ' укажите путь к whisper-cli.exe. Модель — ggml-base или крупнее, файл .bin.';
  }
  return 'macOS: brew install whisper-cpp. Модель скачайте отдельно (ggml-base или крупнее,'
    + ' файл .bin) и укажите путь к ней.';
}

module.exports = { SAMPLE_RATE, BIN_NAMES, wavFromFloat32, findBinary, whisperArgs, parseOutput, setupHint };
