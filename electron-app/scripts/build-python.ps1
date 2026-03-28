# Build Python bridge with PyInstaller
# Produces a standalone distribution in electron-app/python-dist/bridge/

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonDir = Join-Path $scriptDir ".." "python"
$electronDir = Join-Path $scriptDir ".."

Write-Host "Building Python bridge from: $pythonDir"

Push-Location $pythonDir
try {
    python -m PyInstaller san_citro.spec `
        --distpath (Join-Path $electronDir "python-dist") `
        --workpath (Join-Path $electronDir "python-build") `
        --clean -y

    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller build failed with exit code $LASTEXITCODE"
    }

    Write-Host "Python bridge built successfully."
}
finally {
    Pop-Location
}
