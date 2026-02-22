#!/bin/bash

# Create .icns file for macOS from PNG
# macOS requires .icns format for app icons

PNG_PATH="assets/icon.png"
ICONSET_DIR="assets/icon.iconset"
ICNS_PATH="assets/icon.icns"

# Check if PNG exists
if [ ! -f "$PNG_PATH" ]; then
    echo "Error: $PNG_PATH not found!"
    exit 1
fi

# Create iconset directory
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

# Create all required icon sizes for macOS
sips -z 16 16     "$PNG_PATH" --out "$ICONSET_DIR/icon_16x16.png"
sips -z 32 32     "$PNG_PATH" --out "$ICONSET_DIR/icon_16x16@2x.png"
sips -z 32 32     "$PNG_PATH" --out "$ICONSET_DIR/icon_32x32.png"
sips -z 64 64     "$PNG_PATH" --out "$ICONSET_DIR/icon_32x32@2x.png"
sips -z 128 128   "$PNG_PATH" --out "$ICONSET_DIR/icon_128x128.png"
sips -z 256 256   "$PNG_PATH" --out "$ICONSET_DIR/icon_128x128@2x.png"
sips -z 256 256   "$PNG_PATH" --out "$ICONSET_DIR/icon_256x256.png"
sips -z 512 512   "$PNG_PATH" --out "$ICONSET_DIR/icon_256x256@2x.png"
sips -z 512 512   "$PNG_PATH" --out "$ICONSET_DIR/icon_512x512.png"
sips -z 1024 1024 "$PNG_PATH" --out "$ICONSET_DIR/icon_512x512@2x.png"

# Convert iconset to icns
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"

# Clean up iconset directory
rm -rf "$ICONSET_DIR"

if [ -f "$ICNS_PATH" ]; then
    echo "✓ Created $ICNS_PATH successfully!"
    file "$ICNS_PATH"
else
    echo "Error: Failed to create $ICNS_PATH"
    exit 1
fi

