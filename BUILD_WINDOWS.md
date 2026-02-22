# Building Windows Installer

## Prerequisites

1. **Windows machine** (or use WINE on Mac/Linux, but native Windows is recommended)
2. **Node.js** installed
3. All dependencies installed: `npm install`

## Building

### For 64-bit Windows (most common):
```bash
npm run build:win
```

### For 32-bit Windows:
```bash
npm run build:win32
```

### For both architectures:
```bash
npm run build:win-all
```

## Output

The installer will be created in the `dist` folder:
- `PGR2 Beacon-Setup-1.0.0.exe` - NSIS installer

## Troubleshooting

### Installer won't run
- Make sure you're building on Windows (or using WINE)
- Check that all files are included in the build
- Try running as administrator

### Uninstaller doesn't work
- The uninstaller should be accessible from:
  - Control Panel → Programs and Features
  - Start Menu → PGR2 Beacon → Uninstall
- If it doesn't appear, manually delete:
  - `%LOCALAPPDATA%\Programs\pgr2beacon`
  - `%APPDATA%\pgr2beacon`

### Build fails
- Make sure electron-builder is installed: `npm install`
- Check that all required files exist (main.js, index.html, etc.)
- Try cleaning the dist folder: `rm -rf dist` (Mac/Linux) or `rmdir /s dist` (Windows)

## Manual Installation Alternative

If the installer doesn't work, you can:
1. Copy the `win-unpacked` folder from `dist` to your desired location
2. Run `PGR2 Beacon.exe` directly
3. Create a shortcut manually if needed

