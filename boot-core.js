// boot-core.js — чистое решение «чей код запускать»: тот, что лежит в подписанном
// бандле, или обновлённый, который живёт рядом с настройками. Без fs и electron —
// поэтому проверяется обычными тестами (test/boot.test.js).
//
// Зачем это вообще. Раньше обновление лезло внутрь установленного приложения и
// подменяло там app.asar. Подпись macOS покрывает всё содержимое бандла, поэтому
// подмена её ломала, приходилось переподписывать заново уже на машине пользователя —
// а с каждой переподписью у приложения менялся отпечаток. Для системы это каждый раз
// НОВОЕ приложение: выданные разрешения (папки, связка ключей) сбрасывались, и она
// спрашивала всё заново. На винде та же подмена упиралась в заблокированный файл и
// требовала хелпера на PowerShell.
//
// Отсюда правило: бандл после установки не меняется никогда. Обновляемый код лежит
// отдельным файлом в папке настроек, и обновление — это «положить рядом новый файл и
// переставить указатель». Подпись остаётся нетронутой, блокировок нет.
'use strict';

const { compareVersions } = require('./updater-core');

// Папка с обновлённым кодом (внутри userData) и два её служебных файла.
const PAYLOAD_DIR = 'payload';
// Указатель: { version, file } — какой файл считать актуальным.
const POINTER = 'current.json';
// Метка попытки: { version }. Пишется перед загрузкой обновлённого кода и снимается,
// когда приложение доживает до рабочего состояния. Осталась на месте — значит прошлый
// запуск этой версии не дошёл до окна, и второй раз наступать на те же грабли незачем.
const MARKER = 'loading.json';

// Имя файла и есть имя файла: указатель не должен уметь увести загрузку из своей папки.
function safeName(name) {
  return typeof name === 'string' && !!name && !/[\\/]/.test(name) && name !== '..';
}

/**
 * @param {{ pointer: object|null, marker: object|null, bundleVersion: string }} state
 * @returns {{ kind: 'bundle'|'payload', file?: string, version?: string, reason?: string, bad?: string }}
 *   bad — файл, который надо убрать с дороги: он уже уронил запуск.
 */
function decideBoot(state) {
  const p = (state && state.pointer) || null;
  const marker = (state && state.marker) || null;
  const bundleVersion = (state && state.bundleVersion) || '0.0.0';

  if (!p || typeof p.version !== 'string' || !safeName(p.file)) {
    return { kind: 'bundle', reason: 'обновлённого кода нет' };
  }
  // Бандл не старее — значит приложение только что переставили с новым dmg, а рядом
  // лежит обновление от прежней версии. Оно уже неактуально.
  if (compareVersions(p.version, bundleVersion) <= 0) {
    return { kind: 'bundle', reason: 'в бандле версия не старее' };
  }
  if (marker && marker.version === p.version) {
    return {
      kind: 'bundle',
      reason: 'прошлый запуск этой версии не дошёл до окна',
      bad: p.file,
    };
  }
  return { kind: 'payload', file: p.file, version: p.version };
}

module.exports = { decideBoot, safeName, PAYLOAD_DIR, POINTER, MARKER };
