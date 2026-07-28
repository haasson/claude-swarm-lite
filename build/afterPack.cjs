// electron-builder afterPack hook — clean the Info.plist, then ad-hoc sign the
// whole .app bundle.
//
// WHY: on Apple Silicon electron-builder (identity:null) leaves the bundle in a
// broken state — the inner binary is linker-signed ad-hoc, but the .app has no
// sealed CodeResources, so `spctl` reports "code has no resources but signature
// indicates they must be present" and Gatekeeper shows the scary "«…» повреждён,
// переместите в Корзину" on other Macs. Re-signing the bundle ad-hoc (`--sign -`)
// re-seals resources into a consistent signature. It's still unsigned by an
// identified developer, so the first launch shows "unverified developer" (one-time
// "Open Anyway") — but no longer "damaged", and no Terminal/xattr dance needed.
//
// This is the free ceiling. Zero-friction (silent double-click) needs a paid
// Apple Developer ID + notarization.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// electron-builder вписывает в Info.plist заготовки под камеру, микрофон и
// Bluetooth. Аппа их не использует, а наличие ключа — это ровно то, что даёт
// macOS право спросить у пользователя доступ к соответствующей штуке (в том
// числе от имени дочернего процесса: для TCC ответственный процесс — мы, а не
// шелл или claude). Без ключа такой запрос просто отклоняется, без диалога.
// Права на папки (Документы/Рабочий стол/Загрузки) от Info.plist не зависят.
const DROP_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  for (const key of DROP_KEYS) {
    // -remove ругается, если ключа нет — версия electron-builder могла его и не
    // положить, это не повод валить сборку.
    try { execFileSync('plutil', ['-remove', key, plist], { stdio: 'ignore' }); } catch (_) {}
  }
  console.log(`[afterPack] dropped unused usage descriptions: ${DROP_KEYS.join(', ')}`);

  // Подпись — последней: любая правка внутри бандла её ломает.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`[afterPack] ad-hoc re-signed bundle: ${appPath}`);
};
