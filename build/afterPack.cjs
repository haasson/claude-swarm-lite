// electron-builder afterPack hook — ad-hoc sign the whole .app bundle.
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

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`[afterPack] ad-hoc re-signed bundle: ${appPath}`);
};
