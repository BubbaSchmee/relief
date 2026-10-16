# PyInstaller spec: RELIEF desktop app, one folder, no console window.
#   build:   desktop\build.ps1   (builds the web app first, then runs this)
#   by hand: desktop\.venv\Scripts\pyinstaller.exe --noconfirm --clean --distpath dist-desktop --workpath desktop\build desktop\relief.spec   (from the repo root)
#   output:  dist-desktop\RELIEF\RELIEF.exe
#
# Bundles the built web app (app/dist) and this machine's real ffmpeg.exe, so
# ProRes export works offline with nothing installed. That ffmpeg build is
# usually GPL-licensed; this repo does not redistribute the packaged folder.

import glob
import os
import shutil

from PyInstaller.utils.hooks import collect_all

HERE = SPECPATH  # noqa: F821  (injected by PyInstaller: the folder holding this spec)

datas = [(os.path.abspath(os.path.join(HERE, "..", "app", "dist")), "app/dist")]
binaries = []
# pywebview's Windows backend is loaded dynamically (WinForms + Edge WebView2 through
# pythonnet), which PyInstaller cannot see, so name it and collect its assemblies.
hiddenimports = ["webview.platforms.winforms", "webview.platforms.edgechromium", "clr_loader", "clr"]
for pkg in ("webview", "clr_loader", "pythonnet"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h


def _real_tool(name: str) -> str | None:
    """The REAL ffmpeg/ffprobe .exe (not a WinGet shim, which is a stub that points at it)."""
    hits = glob.glob(
        os.path.expandvars(rf"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin\{name}"),
        recursive=True,
    )
    if hits:
        return hits[0]
    found = shutil.which(name[:-4])  # strip ".exe"
    return os.path.realpath(found) if found else None


# ffmpeg only: the app never runs ffprobe (only selftest.py does, at build time,
# from the dev machine), and bundling it would add ~240 MB for nothing.
for tool in ("ffmpeg.exe",):
    path = _real_tool(tool)
    if path and os.path.exists(path):
        datas.append((path, "ffmpeg"))  # -> _internal/ffmpeg/<tool>, found by relief_desktop._bundled_tool
    else:
        raise SystemExit(f"{tool} not found: install ffmpeg (winget install Gyan.FFmpeg) and build again")

a = Analysis(
    [os.path.join(HERE, "relief_desktop.py")],
    pathex=[HERE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["PyQt5", "PyQt6", "PySide2", "PySide6", "gi", "tkinter", "matplotlib", "IPython", "pytest", "PIL"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="RELIEF",
    console=False,  # a window, no command prompt
    icon=os.path.join(HERE, "relief.ico"),
)
coll = COLLECT(exe, a.binaries, a.datas, name="RELIEF")
