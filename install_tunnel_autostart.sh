#!/bin/bash
# Installs start_tunnel.sh as a launchd agent so it auto-starts on Mac login.
# Run once: ./install_tunnel_autostart.sh
# To uninstall: launchctl unload ~/Library/LaunchAgents/com.epicast.tunnel.plist && rm ~/Library/LaunchAgents/com.epicast.tunnel.plist

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TUNNEL_SCRIPT="$SCRIPT_DIR/start_tunnel.sh"
PLIST="$HOME/Library/LaunchAgents/com.epicast.tunnel.plist"

chmod +x "$TUNNEL_SCRIPT"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.epicast.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$TUNNEL_SCRIPT</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/lhr_tunnel.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/lhr_tunnel.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"
echo "✓ Tunnel agent installed — will auto-start on login and restart on crash."
echo "  Monitor: tail -f /tmp/lhr_tunnel.log"
echo "  Stop:    launchctl unload $PLIST"
