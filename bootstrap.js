// bootstrap.js — точка входа приложения. Крошечная нарочно: единственное, что она
// решает, — грузить код из бандла (./main.js) или обновлённый файл из папки настроек.
// Почему обновление живёт снаружи бандла, объяснено в boot-core.js.
//
// Главное свойство этого файла: он не имеет права упасть. Он лежит внутри подписанного
// бандла и не обновляется никогда, поэтому любая ошибка здесь чинится только полной
// переустановкой у каждого пользователя. Отсюда try/catch вокруг всего и запасной путь
// в любой непонятной ситуации — код из бандла, который заведомо рабочий.
'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const core = require('./boot-core');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function boot() {
  const root = path.join(app.getPath('userData'), core.PAYLOAD_DIR);
  const markerPath = path.join(root, core.MARKER);

  let d;
  try {
    d = core.decideBoot({
      pointer: readJson(path.join(root, core.POINTER)),
      marker: readJson(markerPath),
      bundleVersion: require('./package.json').version,
    });
  } catch (e) {
    d = { kind: 'bundle', reason: 'решение о загрузке не сложилось: ' + (e && e.message) };
  }

  // Файл, который уже ронял запуск, убираем с дороги, чтобы указатель на него больше не
  // указывал. Не удаляем: он пригодится, если понадобится понять, что с ним не так.
  if (d.bad) {
    try { fs.renameSync(path.join(root, d.bad), path.join(root, d.bad + '.broken')); } catch (_) {}
    try { fs.unlinkSync(path.join(root, core.POINTER)); } catch (_) {}
    try { fs.unlinkSync(markerPath); } catch (_) {}
  }

  // Что бы ни случилось дальше, main.js увидит это в global и покажет в логе ошибок.
  global.SWARM_BOOT = { kind: 'bundle', version: null, reason: d.reason || '' };

  if (d.kind === 'payload') {
    const file = path.join(root, d.file);
    try {
      // Метка ставится ДО загрузки: если код обновления окажется битым и приложение
      // умрёт по дороге, снять её будет некому — и следующий запуск пойдёт из бандла.
      fs.writeFileSync(markerPath, JSON.stringify({ version: d.version }));
      require(path.join(file, 'main.js'));
      global.SWARM_BOOT = { kind: 'payload', version: d.version, reason: '' };
      watchStartup(markerPath);
      return;
    } catch (e) {
      // Обновление не завелось — метка остаётся, и следующий запуск уйдёт в бандл сам.
      // Здесь же честно грузим бандл, чтобы человек не остался без приложения сейчас.
      global.SWARM_BOOT = {
        kind: 'bundle',
        version: null,
        reason: `обновление ${d.version} не запустилось (${(e && e.message) || e}) — работает версия из установленного приложения`,
      };
    }
  }

  require('./main.js');
}

// Метку снимаем, когда стало ясно, что запуск удался: приложение поднялось и прожило
// несколько секунд после готовности. И отдельно — при обычном выходе: вторая копия
// сворма закрывается сама сразу после старта (см. одиночную блокировку в main.js), и
// без этого её мирный выход выглядел бы как падение.
function watchStartup(markerPath) {
  const clear = () => { try { fs.unlinkSync(markerPath); } catch (_) {} };
  try {
    app.whenReady().then(() => setTimeout(clear, 8000).unref?.());
    app.on('quit', clear);
  } catch (_) {}
}

boot();
