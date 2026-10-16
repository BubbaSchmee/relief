# Build the RELIEF Windows desktop app.
#   .\desktop\build.ps1
# Needs Python 3.12 (py -3.12), pnpm and ffmpeg (winget install Gyan.FFmpeg).
# Output: dist-desktop\RELIEF\RELIEF.exe (a self-contained folder, no install, no
# console, bundled ffmpeg). Also points the Desktop shortcut "RELIEF.lnk" at it.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "[1/5] Python environment" -ForegroundColor Cyan
if (-not (Test-Path $py)) {
    py -3.12 -m venv (Join-Path $PSScriptRoot ".venv")
    if ($LASTEXITCODE -ne 0) { throw "Could not create a Python 3.12 venv (is Python 3.12 installed?)" }
}
& $py -m pip install --quiet --disable-pip-version-check pywebview pyinstaller
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Write-Host "[2/5] Building the web app (pnpm build:app)" -ForegroundColor Cyan
pnpm build:app
if ($LASTEXITCODE -ne 0) { throw "pnpm build:app failed" }

Write-Host "[3/5] Self-test of the local server (native ffmpeg, ProRes 4444)" -ForegroundColor Cyan
& $py (Join-Path $PSScriptRoot "selftest.py")
if ($LASTEXITCODE -ne 0) { throw "selftest failed" }

Write-Host "[4/5] Packaging (PyInstaller, a few minutes)" -ForegroundColor Cyan
& $py -m PyInstaller --noconfirm --clean --distpath (Join-Path $root "dist-desktop") --workpath (Join-Path $PSScriptRoot "build") (Join-Path $PSScriptRoot "relief.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
$exe = Join-Path $root "dist-desktop\RELIEF\RELIEF.exe"
if (-not (Test-Path $exe)) { throw "expected $exe was not produced" }

Write-Host "[5/5] Desktop shortcut" -ForegroundColor Cyan
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath("Desktop"), "RELIEF.lnk"))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = Split-Path $exe
$lnk.IconLocation = "$exe,0"
$lnk.Description = "RELIEF: logo to transparent 3D overlay video"
$lnk.Save()

$mb = [math]::Round(((Get-ChildItem (Split-Path $exe) -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
Write-Host "`nDONE. $exe  ($mb MB folder). The Desktop shortcut now opens it." -ForegroundColor Green
