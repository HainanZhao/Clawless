# Clawless Systemd Service Setup

This guide explains how to run Clawless as a systemd service.

## Prerequisites

- Node.js 18+ installed
- Clawless configured (run `clawless --config` first to set up)

## Quick Setup

Run the setup script as root (it will install the service unit into `/etc/systemd/system`):
```bash
chmod +x scripts/install-service.sh
sudo ./scripts/install-service.sh
```

## Manual Setup

### Option 1: Global npm installation

1. Install clawless globally:
```bash
npm install -g clawless
```

2. Create service file:
```bash
sudo cp clawless.service /etc/systemd/system/clawless.service
```

3. Edit the service file and uncomment the npm global ExecStart line:
```ini
ExecStart=/usr/bin/env clawless
```

### Option 2: Run from source directory

1. Build the project:
```bash
npm run build
```

2. Create service file with your paths:
```bash
sed -i "s|%USER%|$(whoami)|g" clawless.service
sed -i "s|%GROUP%|$(id -gn)|g" clawless.service
sed -i "s|%HOME%|$HOME|g" clawless.service
sed -i "s|%WORKDIR%|$(pwd)|g" clawless.service
sudo cp clawless.service /etc/systemd/system/clawless.service
```

## Service Management

```bash
# Reload systemd daemon
sudo systemctl daemon-reload

# Enable service (start on boot)
sudo systemctl enable clawless

# Start service
sudo systemctl start clawless

# Check status
sudo systemctl status clawless

# View logs
sudo journalctl -u clawless -f

# Stop service
sudo systemctl stop clawless

# Disable service
sudo systemctl disable clawless
```

## Environment Variables

You can create `~/.clawless/env` file with environment variables:
```bash
TELEGRAM_TOKEN=your_token
SLACK_BOT_TOKEN=your_token
LOG_LEVEL=info
```

Or use `~/.clawless/config.json` for configuration.