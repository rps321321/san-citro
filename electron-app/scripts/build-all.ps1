# Full build pipeline for San Citro Electron app
# Runs: Python bridge -> Web frontend -> TypeScript compile -> Electron packaging

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$electronDir = Join-Path $scriptDir ".."

Write-Host "============================================"
Write-Host "  San Citro - Full Build Pipeline"
Write-Host "============================================"
Write-Host ""

# Step 1: Build Python bridge
Write-Host "=== [1/4] Building Python bridge ==="
& (Join-Path $scriptDir "build-python.ps1")
Write-Host ""

# Step 2: Build web frontend
Write-Host "=== [2/4] Building web frontend ==="
& (Join-Path $scriptDir "build-web.ps1")
Write-Host ""

# Step 3: Install dependencies and compile TypeScript
Write-Host "=== [3/4] Compiling Electron main process ==="
Push-Location $electronDir
try {
    npm ci

    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE"
    }

    npx tsc

    if ($LASTEXITCODE -ne 0) {
        throw "TypeScript compilation failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
Write-Host ""

# Step 4: Package with electron-builder
Write-Host "=== [4/4] Packaging Electron app ==="
Push-Location $electronDir
try {
    npx electron-builder --win

    if ($LASTEXITCODE -ne 0) {
        throw "electron-builder failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "============================================"
Write-Host "  Build complete!"
Write-Host "  Installer output: electron-app/release/"
Write-Host "============================================"
