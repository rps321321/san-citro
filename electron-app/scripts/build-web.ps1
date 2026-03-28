# Build Next.js static export for Electron renderer
# Produces static HTML/JS/CSS in electron-app/renderer/

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$webDir = Join-Path $scriptDir ".." ".." "web"
$rendererDir = Join-Path $scriptDir ".." "renderer"

Write-Host "Building web frontend from: $webDir"

# Set empty API URL so the renderer uses relative/IPC paths
$env:NEXT_PUBLIC_API_URL = ""

Push-Location $webDir
try {
    npm run build

    if ($LASTEXITCODE -ne 0) {
        throw "Next.js build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

# Ensure renderer directory exists and copy static export
if (Test-Path $rendererDir) {
    Remove-Item -Path $rendererDir -Recurse -Force
}
New-Item -ItemType Directory -Path $rendererDir -Force | Out-Null

$outDir = Join-Path $webDir "out"
if (-not (Test-Path $outDir)) {
    throw "Next.js output directory not found at $outDir. Ensure next.config has output: 'export'."
}

Copy-Item -Path (Join-Path $outDir "*") -Destination $rendererDir -Recurse -Force
Write-Host "Web frontend copied to: $rendererDir"
