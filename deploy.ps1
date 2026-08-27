# Deploy BMU AI Academic Advisor to VPS (PowerShell equivalent of deploy.sh)
# Usage: .\deploy.ps1
# Set ADVISOR_DEPLOY_REFRESH_DATA=1 when you intentionally want to re-run
# production extraction/seeding before validation.
# Requires: OpenSSH client on Windows and an SSH config entry such as "bmu-server"

$ErrorActionPreference = 'Stop'

$VpsHost  = if ($env:BMU_VPS_HOST) { $env:BMU_VPS_HOST } else { 'bmu-server' }
$AppDir   = '/var/www/bmu-ai-academic-advisor'
$AppName  = 'bmuaiadvisor'
$AppEntry = 'server/app.js'
$HealthBaseUrl = if ($env:ADVISOR_HEALTH_BASE_URL) { $env:ADVISOR_HEALTH_BASE_URL.TrimEnd('/') } else { 'https://advisor.bmuaiagent.mehetti.com' }
$DataRefreshEnv = if ($env:ADVISOR_DEPLOY_REFRESH_DATA) { $env:ADVISOR_DEPLOY_REFRESH_DATA } else { '' }
$RunDataRefresh = @('1', 'true', 'yes') -contains ($DataRefreshEnv.ToString().ToLowerInvariant())

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

Write-Host "[5/6] Checking pm2 status..."
Invoke-Remote "pm2 status $AppName"

if ($RunDataRefresh) {
    Write-Host "[data] Refreshing extracted/seeded academic records before validation..." -ForegroundColor Yellow
    Invoke-Remote "cd $AppDir && npm run extract:student-courses && npm run seed:structured-authority && npm run extract:ccmas && npm run extract:ccmas:structured && npm run sync:requirements && npm run seed:admission-cycle-facts"
} else {
    Write-Host "[data] Skipping production data refresh. Set ADVISOR_DEPLOY_REFRESH_DATA=1 to run extraction/seeding intentionally." -ForegroundColor DarkYellow
}

Write-Host "[6/6] Running strict smoke, data-quality, advisor, and live health checks..."
Invoke-Remote "cd $AppDir && SMOKE_TEST_STRICT=true SMOKE_TEST_URL=`"$HealthBaseUrl/api/health`" SMOKE_TEST_ADVISOR_URL=`"$HealthBaseUrl/api/advisor/health`" npm run test:quality-gate"
Invoke-Remote "curl -fsS `"$HealthBaseUrl/api/health`" >/dev/null"
Invoke-Remote "curl -fsS `"$HealthBaseUrl/api/advisor/health`" >/dev/null"

Write-Host "Deployment complete." -ForegroundColor Green
