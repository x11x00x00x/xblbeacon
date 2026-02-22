#!/usr/bin/env node
/**
 * Generate assets/icon.ico and assets/icon.icns from icon.png (project root).
 * Run before build so the built app uses your current icon.
 * Requires: npm install (sharp, to-ico).
 * For .icns: macOS only (uses iconutil).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const iconPng = path.join(rootDir, 'icon.png');
const assetsDir = path.join(rootDir, 'assets');

if (!fs.existsSync(iconPng)) {
  console.error('icon.png not found in project root. Place your icon there and run again.');
  process.exit(1);
}

if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

(async () => {
  const sharp = require('sharp');

  // --- Windows: generate icon.ico ---
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    icoSizes.map((size) =>
      sharp(iconPng)
        .resize(size, size)
        .png()
        .toBuffer()
    )
  );

  let toIco;
  try {
    toIco = require('to-ico');
  } catch (e) {
    console.error('Missing dependency: run npm install to-ico --save-dev');
    process.exit(1);
  }

  const icoBuffer = await toIco(pngBuffers);
  const icoPath = path.join(assetsDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Written', icoPath);

  // --- macOS: generate icon.icns (only on macOS) ---
  if (process.platform !== 'darwin') {
    console.log('Skipping .icns (iconutil is macOS-only). Run this script on macOS to update icon.icns.');
    return;
  }

  const iconsetDir = path.join(assetsDir, 'icon.iconset');
  if (fs.existsSync(iconsetDir)) {
    fs.rmSync(iconsetDir, { recursive: true });
  }
  fs.mkdirSync(iconsetDir, { recursive: true });

  const icnsSizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];

  for (const [size, name] of icnsSizes) {
    const buf = await sharp(iconPng).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(iconsetDir, name), buf);
  }

  const icnsPath = path.join(assetsDir, 'icon.icns');
  execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, { stdio: 'inherit' });
  fs.rmSync(iconsetDir, { recursive: true });
  console.log('Written', icnsPath);
})();
