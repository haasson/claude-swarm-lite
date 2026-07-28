// Тесты чистой части голосового ввода (voice.js): WAV-упаковка, поиск бинарника,
// аргументы и разбор вывода whisper.cpp. Без сети, без звука, без самого whisper.
const assert = require('assert');
const V = require('../voice');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('wavFromFloat32 пишет корректный заголовок 16 кГц моно 16 бит', () => {
  const wav = V.wavFromFloat32(new Float32Array(8), 16000);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.readUInt16LE(22), 1, 'моно');
  assert.strictEqual(wav.readUInt32LE(24), 16000);
  assert.strictEqual(wav.readUInt16LE(34), 16, 'бит на сэмпл');
  assert.strictEqual(wav.readUInt32LE(40), 16, 'размер data = 8 сэмплов * 2 байта');
  assert.strictEqual(wav.length, 44 + 16);
});

test('wavFromFloat32 клиппит громкое, а не заворачивает его в треск', () => {
  const wav = V.wavFromFloat32([2, -2, 0], 16000);
  assert.strictEqual(wav.readInt16LE(44), 32767);
  assert.strictEqual(wav.readInt16LE(46), -32768);
  assert.strictEqual(wav.readInt16LE(48), 0);
});

test('wavFromFloat32 не падает на пустом входе', () => {
  assert.strictEqual(V.wavFromFloat32(null).length, 44);
});

// --- поиск бинарника ---------------------------------------------------------

const finder = (present, over) => V.findBinary(Object.assign({
  pathEnv: '/opt/homebrew/bin:/usr/bin',
  exists: (p) => present.includes(p),
  join: (a, b) => a + '/' + b,
}, over));

test('findBinary берёт первое подходящее имя из PATH', () => {
  assert.strictEqual(finder(['/usr/bin/whisper-cli']), '/usr/bin/whisper-cli');
  assert.strictEqual(finder(['/opt/homebrew/bin/whisper-cpp']), '/opt/homebrew/bin/whisper-cpp');
});

test('findBinary на Windows ищет .exe и по ; в PATH', () => {
  const got = V.findBinary({
    isWin: true,
    pathEnv: 'C:\\tools;C:\\bin',
    join: (a, b) => a + '\\' + b,
    exists: (p) => p === 'C:\\tools\\whisper-cli.exe',
  });
  assert.strictEqual(got, 'C:\\tools\\whisper-cli.exe');
});

test('указанный руками путь не подменяется тихо чем-то из PATH', () => {
  assert.strictEqual(finder(['/usr/bin/whisper-cli'], { configured: '/opt/my/whisper' }), null,
    'промах в настройках должен быть виден, а не замаскирован');
  assert.strictEqual(finder(['/opt/my/whisper'], { configured: '/opt/my/whisper' }), '/opt/my/whisper');
});

test('findBinary возвращает null, когда ничего нет', () => {
  assert.strictEqual(finder([]), null);
  assert.strictEqual(V.findBinary(null), null);
});

// --- аргументы и разбор ------------------------------------------------------

test('whisperArgs просит текст без таймкодов и без прогресса', () => {
  const a = V.whisperArgs({ model: '/m/ggml-base.bin', wav: '/tmp/a.wav' });
  assert.deepStrictEqual(a, ['-m', '/m/ggml-base.bin', '-f', '/tmp/a.wav', '-l', 'ru', '-nt', '-np']);
});

test('parseOutput достаёт фразу и выбрасывает служебные строки', () => {
  const out = [
    'whisper_init_from_file_with_params_no_state: loading model',
    'system_info: n_threads = 4',
    'Посмотри, почему падает тест на миграциях.',
  ].join('\n');
  assert.strictEqual(V.parseOutput(out), 'Посмотри, почему падает тест на миграциях.');
});

test('parseOutput снимает таймкод, если версия его печатает', () => {
  assert.strictEqual(V.parseOutput('[00:00:00.000 --> 00:00:03.100]   Открой api.'), 'Открой api.');
});

test('parseOutput на тишине даёт пустую строку, а не «[BLANK_AUDIO]»', () => {
  assert.strictEqual(V.parseOutput('[BLANK_AUDIO]'), '');
  assert.strictEqual(V.parseOutput('(музыка)'), '');
  assert.strictEqual(V.parseOutput(''), '');
  assert.strictEqual(V.parseOutput(null), '');
});

test('setupHint говорит про brew на маке и про релизы на винде', () => {
  assert.ok(/brew install whisper-cpp/.test(V.setupHint('darwin')));
  assert.ok(/whisper-cli\.exe/.test(V.setupHint('win32')));
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' voice tests passed');
