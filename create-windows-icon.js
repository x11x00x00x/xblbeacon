#!/usr/bin/env node

/**
 * Create Windows .ico file from PNG
 * This requires imagemagick or a similar tool
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pngPath = path.join(__dirname, 'assets', 'icon.png');
const icoPath = path.join(__dirname, 'assets', 'icon.ico');

// Check if PNG exists
if (!fs.existsSync(pngPath)) {
    console.error('icon.png not found!');
    process.exit(1);
}

// Try to use ImageMagick to convert PNG to ICO
try {
    // Try convert (ImageMagick 6)
    try {
        execSync(`convert "${pngPath}" -define icon:auto-resize=256,128,64,48,32,16 "${icoPath}"`, { stdio: 'inherit' });
        console.log('✓ Created icon.ico using ImageMagick convert');
    } catch (e) {
        // Try magick (ImageMagick 7)
        try {
            execSync(`magick "${pngPath}" -define icon:auto-resize=256,128,64,48,32,16 "${icoPath}"`, { stdio: 'inherit' });
            console.log('✓ Created icon.ico using ImageMagick magick');
        } catch (e2) {
            console.error('ImageMagick not found. Please install ImageMagick:');
            console.error('  macOS: brew install imagemagick');
            console.error('  Windows: Download from https://imagemagick.org/script/download.php');
            console.error('  Linux: sudo apt-get install imagemagick');
            console.error('');
            console.error('Alternatively, you can:');
            console.error('  1. Use an online converter: https://convertio.co/png-ico/');
            console.error('  2. Save icon.png as icon.ico manually');
            console.error('  3. Or remove icon references from package.json');
            process.exit(1);
        }
    }
} catch (error) {
    console.error('Error creating icon:', error.message);
    process.exit(1);
}

