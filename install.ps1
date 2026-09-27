# 1-click installer for the discord-channel-exporter Vencord userplugin.
#   Windows: install.cmd   (or: powershell -ExecutionPolicy Bypass -File install.ps1)
#   macOS/Linux: pwsh ./install.ps1
# Finds your Vencord checkout, drops the plugin in src/userplugins, builds, and
# deploys dist to the already-injected Vencord data dir (or runs `pnpm inject`).
$ErrorActionPreference = "Stop"

$Plugin = "FetchChannelMessages"
$Src    = Split-Path -Parent $MyInvocation.MyCommand.Path
$isWin  = $env:OS -eq "Windows_NT"
$isMac  = !$isWin -and (Test-Path "/System/Library/CoreServices/SystemVersion.plist")
$Home_  = if ($isWin) { $env:USERPROFILE } else { $env:HOME }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Die($m)  { Write-Host "X $m" -ForegroundColor Red; exit 1 }

try {
    # 1. locate a Vencord source tree (must contain src/userplugins)
    Step "Looking for Vencord..."
    $vc = @(
        $env:VENCORD_DIR,
        "$Src\..\Vencord", "$Src\Vencord",
        "$Home_\Vencord", "$Home_\Documents\Vencord", "$Home_\Downloads\Vencord",
        "$Home_\Desktop\Vencord", "$Home_\source\repos\Vencord", "$Home_\code\Vencord"
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "src\userplugins")) } | Select-Object -First 1

    if (!$vc) {
        # ponytail: clone to a fixed spot instead of asking - one less prompt for "1 click"
        $vc = Join-Path $Home_ "Vencord"
        Step "No Vencord checkout found, cloning to $vc (needs git)..."
        & git clone --depth 1 https://github.com/Vendicated/Vencord.git $vc
        if ($LASTEXITCODE -ne 0 -or !(Test-Path (Join-Path $vc "src\userplugins"))) { Die "git clone failed. Install git and re-run." }
    }
    Write-Host "    $vc" -ForegroundColor DarkGray
    Set-Location $vc   # pnpm/npm must run inside the Vencord checkout

    # 2. copy plugin sources in
    $dst = Join-Path $vc "src\userplugins\$Plugin"
    New-Item -ItemType Directory -Force $dst | Out-Null
    Copy-Item (Join-Path $Src "*.ts"), (Join-Path $Src "*.tsx") $dst -Force
    Write-Host "    copied *.ts, *.tsx -> src/userplugins/$Plugin" -ForegroundColor DarkGray

    # 3. deps + build
    $pm = if (Get-Command pnpm -ErrorAction SilentlyContinue) { "pnpm" } else { "npm" }
    if (!(Test-Path (Join-Path $vc "node_modules"))) {
        Step "Installing Vencord dependencies ($pm)..."
        & $pm install
        if ($LASTEXITCODE -ne 0) { Die "$pm install failed" }
    }
    Step "Building Vencord ($pm run build)..."
    & $pm run build
    if ($LASTEXITCODE -ne 0) { Die "build failed - see output above" }

    # 4. deploy: already-injected Vencord reads dist from its data dir, else inject
    $data = if ($isWin) { "$env:APPDATA\Vencord\dist" }
            elseif ($isMac) { "$Home_\Library\Application Support\Vencord\dist" }
            else            { "$Home_\.config\Vencord\dist" }

    if (Test-Path $data) {
        Step "Deploying dist -> $data"
        Copy-Item (Join-Path $vc "dist\*") $data -Recurse -Force
    } else {
        Step "Vencord not injected yet - running $pm run inject (may ask for your password)"
        & $pm run inject
        if ($LASTEXITCODE -ne 0) { Die "inject failed - re-run as admin/sudo" }
    }

    Step "Done."
    Write-Host "Fully quit Discord (not just the window) and reopen it." -ForegroundColor Green
    Write-Host "Buttons appear stacked left of the chat box. Logs in console: [FCM]"
} catch {
    Die $_.Exception.Message
}
