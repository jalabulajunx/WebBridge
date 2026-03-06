#!/usr/bin/env bash
# WebBridge Native Host Installer — macOS (Google Chrome + Chromium)
#
# Usage:
#   bash install-mac.sh <extension-id>

set -euo pipefail

EXTENSION_ID="${1:-}"
if [ -z "$EXTENSION_ID" ]; then
  echo "Usage: bash install-mac.sh <chrome-extension-id>"
  echo ""
  echo "Find the extension ID at chrome://extensions after loading WebBridge."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_JS="$SCRIPT_DIR/host.js"

if [ ! -f "$HOST_JS" ]; then
  echo "ERROR: host.js not found at: $HOST_JS"
  exit 1
fi

chmod +x "$HOST_JS"

NODE_BIN="$(which node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH."
  exit 1
fi

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

# Google Chrome
CHROME_NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$CHROME_NMH_DIR"
echo "$MANIFEST" > "$CHROME_NMH_DIR/com.webbridge.host.json"
echo "✓ Chrome: $CHROME_NMH_DIR/com.webbridge.host.json"

# Chromium
CHROMIUM_NMH_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
mkdir -p "$CHROMIUM_NMH_DIR"
echo "$MANIFEST" > "$CHROMIUM_NMH_DIR/com.webbridge.host.json"
echo "✓ Chromium: $CHROMIUM_NMH_DIR/com.webbridge.host.json"

# Create ~/.webbridge
mkdir -p "$HOME/.webbridge/sites"
chmod 700 "$HOME/.webbridge"
echo "✓ Created: ~/.webbridge/"

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Reload WebBridge at chrome://extensions"
echo "  2. Click the WebBridge icon — status dot should turn green"
echo "  3. Browse to a site you're logged into, click 'Record'"
echo "  4. Perform actions you want to automate, click 'Stop'"
echo "  5. In Claude: /webbridge generate <site-id>"
