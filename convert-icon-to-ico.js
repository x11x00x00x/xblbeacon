#!/usr/bin/env node

/**
 * Convert PNG to ICO for Windows
 * Uses sharp library if available, otherwise provides instructions
 */

const fs = require('fs');
const path = require('path');

const pngPath = path.join(__dirname, 'assets', 'icon.png');
const icoPath = path.join(__dirname, 'assets', 'icon.ico');

if (!fs.existsSync(pngPath)) {
    console.error('icon.png not found!');
    process.exit(1);
}

// Try using sharp (lightweight image processing library)
try {
    const sharp = require('sharp');
    
    console.log('Converting icon.png to icon.ico using sharp...');
    
    // Read the PNG and convert to ICO
    // Note: sharp doesn't directly support ICO, so we'll use sips or ImageMagick
    createIcoManually();
} catch (error) {
    console.log('sharp not available, trying alternative methods...');
    createIcoManually();
}

function createIcoManually() {
    const { execSync } = require('child_process');
    
    // Try sips on macOS first (built-in, most reliable)
    try {
        execSync(`sips -s format ico -z 256 256 "${pngPath}" --out "${icoPath}"`, { stdio: 'inherit' });
        console.log('✓ Created icon.ico using sips');
        return;
    } catch (e3) {
        // sips failed, try ImageMagick
    }
    
    try {
        // Try convert (ImageMagick 6)
        execSync(`convert "${pngPath}" -define icon:auto-resize=256,128,64,48,32,16 "${icoPath}"`, { stdio: 'inherit' });
        console.log('✓ Created icon.ico using ImageMagick convert');
    } catch (e) {
        try {
            // Try magick (ImageMagick 7)
            execSync(`magick "${pngPath}" -define icon:auto-resize=256,128,64,48,32,16 "${icoPath}"`, { stdio: 'inherit' });
            console.log('✓ Created icon.ico using ImageMagick magick');
        } catch (e2) {
            console.error('\nCould not convert icon automatically.');
            console.error('Please install one of the following:');
            console.error('  1. ImageMagick: brew install imagemagick (macOS)');
            console.error('  2. Or use an online converter: https://convertio.co/png-ico/');
            console.error('  3. Or copy icon.png and rename to icon.ico manually');
            console.error('\nFor now, the app will use the default Electron icon.');
            process.exit(1);
        }
    }
}

