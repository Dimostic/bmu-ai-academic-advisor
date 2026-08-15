#!/bin/bash
# Deploy BMU AI Academic Advisor to VPS
# Usage: ./deploy.sh

set -e

VPS_HOST="${BMU_VPS_HOST:-bmu-server}"
APP_DIR="/var/www/bmu-ai-academic-advisor"
APP_NAME="bmuaiadvisor"
APP_ENTRY="server/app.js"

echo "🚀 Deploying BMU AI Academic Advisor to VPS..."

# Pull latest code (safe fast-forward only)
echo "📥 Pulling latest code (ff-only)..."
ssh $VPS_HOST "cd $APP_DIR && git fetch origin main && git pull --ff-only origin main"

# Ensure pm2 is available
echo "🔧 Checking pm2..."
ssh $VPS_HOST "command -v pm2 >/dev/null 2>&1"

# Stop systemd service if it exists to avoid port conflicts
echo "🛑 Stopping systemd service (if present)..."
ssh $VPS_HOST "if systemctl list-units --full -all | grep -Fq 'bmuaiagent.service'; then sudo systemctl stop bmuaiagent || true; fi"
ssh $VPS_HOST "for legacy in bmu-ai-academic-advisor bmuaiagent; do if [ \"\$legacy\" != \"$APP_NAME\" ] && pm2 describe \"\$legacy\" >/dev/null 2>&1; then pm2 delete \"\$legacy\" || true; fi; done"

# Restart via pm2
echo "🔄 Restarting app with pm2..."
ssh $VPS_HOST "cd $APP_DIR && if pm2 describe $APP_NAME >/dev/null 2>&1; then pm2 reload $APP_NAME --update-env; else pm2 start $APP_ENTRY --name $APP_NAME; fi"
ssh $VPS_HOST "pm2 save"

# Wait for service to start
echo "⏳ Waiting for service to start..."
sleep 3

# Check status
echo "✅ Checking pm2 status..."
ssh $VPS_HOST "pm2 status $APP_NAME"

# Run smoke test (uses SMOKE_TEST_URL from .env if set)
echo "🧪 Running smoke test..."
ssh $VPS_HOST "cd $APP_DIR && npm test"

echo ""
echo "🎉 Deployment complete!"
