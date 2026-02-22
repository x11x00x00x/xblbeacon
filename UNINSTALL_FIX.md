# Fixing Uninstaller Integrity Check Error

If you're getting an "installer integrity check failed" error when trying to uninstall, here are solutions:

## Easiest Fix - Use the PowerShell Script

1. **Right-click on `uninstall.ps1`** in the pgr2beacon folder
2. Select **"Run with PowerShell"**
3. The script will automatically remove everything

If you get an execution policy error:
- Open PowerShell as Administrator
- Run: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
- Then run the uninstall script again

## Manual Uninstall

1. **Delete the application folder:**
   - Press `Win + R`, type: `%LOCALAPPDATA%\Programs\pgr2beacon`
   - Delete the entire folder

2. **Delete application data:**
   - Press `Win + R`, type: `%APPDATA%\pgr2beacon`
   - Delete the entire folder

3. **Remove registry entries:**
   - Press `Win + R`, type `regedit`, press Enter
   - Navigate to: `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.pgr2stats.beacon`
   - Delete this key if it exists
   - Also check: `HKEY_CURRENT_USER\Software\PGR2Beacon` and delete if exists

4. **Remove startup entry:**
   - Press `Win + R`, type `regedit`, press Enter
   - Navigate to: `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`
   - Delete "PGR2 Beacon" entry if it exists

## Rebuild the Installer

After fixing the configuration, rebuild the installer:

```bash
# Clean previous build
rm -rf dist

# Rebuild
npm run build:win
```

The new installer should have a working uninstaller.

## Why This Happens

The integrity check error usually occurs when:
- The uninstaller file is missing or corrupted
- The installer was built incorrectly
- Files were moved or deleted after installation
- Antivirus software interfered with the installation

The updated configuration should prevent this issue in future builds.

