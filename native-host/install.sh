#!/usr/bin/env bash
# WebBridge Native Host Installer — Linux (Google Chrome + Chromium)
#
# Usage:
#   bash install.sh <extension-id>
#
# The extension-id is shown at chrome://extensions after loading the
# WebBridge extension in Developer Mode. It looks like:
#   abcdefghijklmnopqrstuvwxyz123456
#
# This script:
#   1. Writes ~/.config/google-chrome/NativeMessagingHosts/com.webbridge.host.json
#   2. Optionally writes the Chromium path too
#   3. Makes host.js executable

set -euo pipefail

EXTENSION_ID="${1:-}"
if [ -z "$EXTENSION_ID" ]; then
  echo "Usage: bash install.sh <chrome-extension-id>"
  echo ""
  echo "Find the extension ID at chrome://extensions after loading WebBridge."
  exit 1
fi

# Resolve the absolute path to host.js
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$SCRIPT_DIR/host.js"

if [ ! -f "$HOST_JS" ]; then
  echo "ERROR: host.js not found at: $HOST_JS"
  exit 1
fi

# Make host.js executable and ensure it has a proper shebang
chmod +x "$HOST_JS"

# Detect node binary
NODE_BIN="$(which node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH. Install Node.js 18+ first."
  exit 1
fi

# Build the manifest JSON
MANIFEST=$(cat <<EOF
{
  "name": "com.webbridge.host",
  "description": "WebBridge Native Messaging Host",
  "path": "$HOST_JS",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
)

# Install for Google Chrome
CHROME_NMH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
mkdir -p "$CHROME_NMH_DIR"
echo "$MANIFEST" > "$CHROME_NMH_DIR/com.webbridge.host.json"
echo "✓ Chrome:  $CHROME_NMH_DIR/com.webbridge.host.json"

# Install for Chromium
CHROMIUM_NMH_DIR="$HOME/.config/chromium/NativeMessagingHosts"
mkdir -p "$CHROMIUM_NMH_DIR"
echo "$MANIFEST" > "$CHROMIUM_NMH_DIR/com.webbridge.host.json"
echo "✓ Chromium: $CHROMIUM_NMH_DIR/com.webbridge.host.json"

# Create ~/.webbridge directory
mkdir -p "$HOME/.webbridge/sites"
chmod 700 "$HOME/.webbridge"
echo "✓ Created: ~/.webbridge/"

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Reload the WebBridge extension at chrome://extensions"
echo "  2. Click the WebBridge icon — the status dot should turn green"
echo "  3. Browse to a site you're logged into and click 'Record'"
echo "  4. Perform the actions you want to automate, then click 'Stop'"
echo "  5. In Claude, run:  /webbridge generate <site-id>"
