# Populate electron-app/bin/ with the bundled runtime tools (gitignored, too
# large for git). electron-builder ships bin/ via extraResources, and the
# Python media-tools locator finds them through the SAN_CITRO_7Z / SAN_CITRO_FFPROBE
# env vars set by python-bridge.ts. Run before a release build.
#
#   7z.exe + 7z.dll  -> archive extraction (zip/rar/7z)
#   ffprobe.exe      -> audio durations + m4b chapters

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path (Join-Path $scriptDir "..") "bin"
New-Item -ItemType Directory -Path $bin -Force | Out-Null

# --- 7-Zip (7z.exe needs 7z.dll beside it for rar/7z codecs) ---
$sevenZip = "C:\Program Files\7-Zip"
if (-not (Test-Path (Join-Path $sevenZip "7z.exe"))) {
    throw "7-Zip not found at $sevenZip. Install 7-Zip (https://www.7-zip.org/)."
}
Copy-Item (Join-Path $sevenZip "7z.exe") $bin -Force
Copy-Item (Join-Path $sevenZip "7z.dll") $bin -Force

# --- ffprobe (resolve the real exe; WinGet installs a symlink shim) ---
$ffCmd = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $ffCmd) {
    throw "ffprobe not found on PATH. Install ffmpeg (e.g. winget install Gyan.FFmpeg)."
}
$ffItem = Get-Item $ffCmd.Source
$ffReal = if ($ffItem.Target) { $ffItem.Target | Select-Object -First 1 } else { $ffCmd.Source }
Copy-Item $ffReal (Join-Path $bin "ffprobe.exe") -Force

Write-Host "Bundled binaries synced to $bin :"
Get-ChildItem $bin | Select-Object Name, @{N="MB";E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
