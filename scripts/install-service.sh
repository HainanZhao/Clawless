#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_FILE="/etc/systemd/system/clawless.service"

echo "=== Clawless Systemd Service Installer ==="

# Check if running as root for service installation
if [ "$EUID" -ne 0 ]; then
    echo "This script needs sudo access to install the service."
    exit 1
fi

# Get the actual user (even when running with sudo)
ACTUAL_USER="${SUDO_USER:-$USER}"
ACTUAL_HOME=$(eval echo "~$ACTUAL_USER")
ACTUAL_GROUP=$(id -gn "$ACTUAL_USER")

echo "User: $ACTUAL_USER"
echo "Home: $ACTUAL_HOME"
echo "Project: $PROJECT_DIR"

# Build if needed
if [ ! -d "$PROJECT_DIR/dist" ]; then
    echo "Building project..."
    cd "$PROJECT_DIR"
    npm run build
fi

# Create service file from template
echo "Creating service file..."
sed -e "s|%USER%|$ACTUAL_USER|g" \
    -e "s|%GROUP%|$ACTUAL_GROUP|g" \
    -e "s|%HOME%|$ACTUAL_HOME|g" \
    -e "s|%WORKDIR%|$PROJECT_DIR|g" \
    "$PROJECT_DIR/clawless.service" > "$SERVICE_FILE"

# Reload systemd
echo "Reloading systemd daemon..."
systemctl daemon-reload

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Commands:"
echo "  sudo systemctl enable clawless  # Start on boot"
echo "  sudo systemctl start clawless   # Start now"
echo "  sudo systemctl status clawless  # Check status"
echo "  sudo journalctl -u clawless -f  # View logs"