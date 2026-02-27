/**
 * After pack hook: clear macOS quarantine extended attributes on the .app
 * so the app in the DMG is less likely to show "damaged" / "corrupted" when
 * copied to Applications (Gatekeeper often blocks unsigned apps; clearing
 * xattr helps in some cases; full fix is code signing + notarization).
 */
const path = require("path");
const { execSync } = require("child_process");

module.exports = async function (context) {
  if (context.electronPlatformName !== "darwin") return;
  const productName = context.packager.appInfo.productName;
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  try {
    // macOS xattr has no -r; clear recursively with find
    execSync(`find "${appPath}" -print0 | xargs -0 xattr -c 2>/dev/null || true`, {
      stdio: "inherit",
      shell: true,
    });
  } catch (e) {
    console.warn("afterPack: xattr clear failed (non-fatal):", e.message);
  }
};
