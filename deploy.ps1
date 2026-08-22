# Deploy BMU AI Academic Advisor to VPS (PowerShell equivalent of deploy.sh)
# Usage: .\deploy.ps1
# Requires: OpenSSH client on Windows and an SSH config entry such as "bmu-server"

$ErrorActionPreference = 'Stop'

$VpsHost  = if ($env:BMU_VPS_HOST) { $env:BMU_VPS_HOST } else { 'bmu-server' }
$AppDir   = '/var/www/bmu-ai-academic-advisor'
$AppName  = 'bmuaiadvisor'
$AppEntry = 'server/app.js'

function Invoke-Remote([string]$Cmd) {
    Write-Host "  ssh> $Cmd" -ForegroundColor DarkGray
    ssh $VpsHost $Cmd
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed: $Cmd" }
}

Write-Host "Deploying BMU AI Academic Advisor to VPS..." -ForegroundColor Cyan

Write-Host "[1/5] Pulling latest code (ff-only)..."
Invoke-Remote "cd $AppDir && git fetch origin main && git pull --ff-only origin main"

Write-Host "[2/5] Checking pm2 is installed..."
Invoke-Remote "command -v pm2 >/dev/null 2>&1"

Write-Host "[3/5] Stopping legacy Academic Advisor PM2 process (if present)..."
Invoke-Remote "legacy=bmu-ai-academic-advisor; if [ `"`$legacy`" != `"$AppName`" ] && pm2 describe `"`$legacy`" >/dev/null 2>&1; then pm2 delete `"`$legacy`" || true; fi"

Write-Host "[4/5] Restarting app with pm2..."
Invoke-Remote "cd $AppDir && if pm2 describe $AppName >/dev/null 2>&1; then pm2 reload $AppName --update-env; else pm2 start $AppEntry --name $AppName; fi"
Invoke-Remote 'pm2 save'

Start-Sleep -Seconds 3

Write-Host "[5/5] Checking pm2 status + running smoke and golden advisor tests..."
Invoke-Remote "pm2 status $AppName"
Invoke-Remote "cd $AppDir && npm test && npm run test:advisor-golden"

Write-Host "Deployment complete." -ForegroundColor Green
