/**
 * After pack hook:
 * - Force macOS bundle display name (Dock hover / menu bar) to productName
 * - Fix helper app CFBundleName values that still say "Electron Helper"
 * - Clear quarantine xattrs on the .app (unsigned DMG workaround)
 */
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

function plistSet(plistPath, key, value) {
    const escaped = String(value).replace(/"/g, '\\"');
    try {
        execSync(`/usr/libexec/PlistBuddy -c 'Set :${key} "${escaped}"' "${plistPath}"`, {
            stdio: "pipe",
        });
    } catch {
        try {
            execSync(`/usr/libexec/PlistBuddy -c 'Add :${key} string "${escaped}"' "${plistPath}"`, {
                stdio: "pipe",
            });
        } catch (e) {
            console.warn(`afterPack: could not set ${key} in ${plistPath}:`, e.message);
        }
    }
}

function patchMacAppBundle(appPath, productName) {
    const mainPlist = path.join(appPath, "Contents", "Info.plist");
    if (fs.existsSync(mainPlist)) {
        plistSet(mainPlist, "CFBundleDisplayName", productName);
        plistSet(mainPlist, "CFBundleName", productName);
    }

    const frameworksDir = path.join(appPath, "Contents", "Frameworks");
    if (!fs.existsSync(frameworksDir)) return;

    for (const entry of fs.readdirSync(frameworksDir)) {
        if (!entry.endsWith(".app")) continue;
        const helperPlist = path.join(frameworksDir, entry, "Contents", "Info.plist");
        if (!fs.existsSync(helperPlist)) continue;
        const displayName = entry.replace(/\.app$/, "");
        plistSet(helperPlist, "CFBundleDisplayName", displayName);
        plistSet(helperPlist, "CFBundleName", displayName);
    }
}

module.exports = async function (context) {
    if (context.electronPlatformName !== "darwin") return;
    const productName = context.packager.appInfo.productName;
    const appPath = path.join(context.appOutDir, `${productName}.app`);

    if (fs.existsSync(appPath)) {
        patchMacAppBundle(appPath, productName);
    }

    try {
        execSync(`find "${appPath}" -print0 | xargs -0 xattr -c 2>/dev/null || true`, {
            stdio: "inherit",
            shell: true,
        });
    } catch (e) {
        console.warn("afterPack: xattr clear failed (non-fatal):", e.message);
    }
};
