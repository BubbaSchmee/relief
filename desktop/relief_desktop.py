"""RELIEF desktop app (Windows): the browser app in its own window, plus a tiny
local API for the three things a browser cannot do well:

  * encode ProRes 4444 with a NATIVE ffmpeg (no 32 MB wasm download, no memory cap),
  * show the native Save dialog (pywebview does not reliably handle <a download>),
  * stream frames to disk instead of holding a whole clip in memory.

The server listens on 127.0.0.1 only, on a random port. Every /api/ request must
carry this launch's random token and be same-origin, so no other web page or
browser tab on the machine can drive it. Static files (the built app) need no token.

  python relief_desktop.py        open the window (needs ../app/dist: pnpm build:app)
  selftest.py                     the same server, no window, checked against ffprobe
"""

from __future__ import annotations

import glob
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# A console-subsystem child (ffmpeg) of a windowed exe opens its own console
# window unless told not to. 0 off Windows, where the flag does not exist.
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

MAX_FRAME_BYTES = 128 * 1024 * 1024  # one 4K PNG is far smaller
MAX_SAVE_BYTES = 4 * 1024 * 1024 * 1024
MAX_FRAME_INDEX = 99_999
MAX_JOBS = 8
ENCODE_TIMEOUT_S = 3 * 3600
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# The built app must be served with real JS/WASM types whatever the registry says
# (module scripts are refused as text/plain).
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
    ".wasm": "application/wasm", ".woff2": "font/woff2", ".ico": "image/x-icon",
}


# ------------------------------------------------------------------ ffmpeg discovery
def _bundled_tool(name: str) -> str | None:
    """A tool shipped INSIDE the packaged app (the spec puts it in <bundle>/ffmpeg)."""
    base = getattr(sys, "_MEIPASS", None)
    p = Path(base) / "ffmpeg" / name if base else None
    return str(p) if p and p.exists() else None


def find_ffmpeg() -> str | None:
    bundled = _bundled_tool("ffmpeg.exe")
    if bundled:
        return bundled
    for cand in (
        "ffmpeg",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"),
        *glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\**\bin\ffmpeg.exe"), recursive=True),
    ):
        found = shutil.which(cand)
        if found:
            return found
    return None


def find_ffprobe() -> str | None:
    """ffprobe sits beside ffmpeg."""
    bundled = _bundled_tool("ffprobe.exe")
    if bundled:
        return bundled
    ff = find_ffmpeg()
    if not ff:
        return None
    probe = re.sub(r"ffmpeg(\.exe)?$", r"ffprobe\1", ff, flags=re.IGNORECASE)
    return probe if os.path.exists(probe) else shutil.which("ffprobe")


# ------------------------------------------------------------------ the server
class HttpError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def safe_name(raw: str) -> str:
    """A plain file name: no separators, no drive, no leading dots."""
    name = re.sub(r"[^\w .()\-]", "_", raw).strip(" .")[:120]
    if not name:
        raise HttpError(400, "bad file name")
    return name


def encode_argv(ffmpeg: str, fps: str) -> list[str]:
    """The verified ProRes 4444 command (app/encoders.ts ran the same one under
    ffmpeg.wasm). Every flag matters: the scale filter fixes a measured BT.601
    colour shift, and the bitstream filter writes bt709 into each frame header,
    which prores_ks leaves unspecified."""
    return [
        ffmpeg, "-y", "-framerate", fps, "-i", "f%04d.png",
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le",
        "-c:v", "prores_ks", "-profile:v", "4444", "-alpha_bits", "16", "-vendor", "apl0",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-bsf:v", "prores_metadata=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "out.mov",
    ]


class Handler(SimpleHTTPRequestHandler):
    server_version = "RELIEF"
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME}
    server: "ReliefServer"

    def __init__(self, request, client_address, server):
        super().__init__(request, client_address, server, directory=str(server.static_root))

    def log_message(self, *args):  # a windowed exe has no stderr
        pass

    def list_directory(self, path):
        self.send_error(404)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- routing: static files for GET/HEAD, /api/ for everything else
    def do_GET(self):
        self._dispatch(super().do_GET)

    def do_HEAD(self):
        self._dispatch(super().do_HEAD)

    def do_POST(self):
        self._dispatch(None)

    def do_PUT(self):
        self._dispatch(None)

    def do_DELETE(self):
        self._dispatch(None)

    def do_OPTIONS(self):  # no CORS, ever: a cross-origin preflight must fail
        self._json(403, {"ok": False, "error": "forbidden"})

    def _dispatch(self, static):
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            return static() if static else self._json(404, {"ok": False, "error": "not found"})
        try:
            self._check_caller()
            self._route(url)
        except HttpError as e:
            self._json(e.code, {"ok": False, "error": e.message})
        except Exception as e:  # never leave the page hanging on a bug
            self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def _check_caller(self):
        port = self.server.server_port
        origin = f"http://127.0.0.1:{port}"
        site, org = self.headers.get("Sec-Fetch-Site"), self.headers.get("Origin")
        ok = (
            hmac.compare_digest(self.headers.get("X-Relief-Token", ""), self.server.token)
            and self.headers.get("Host") == f"127.0.0.1:{port}"  # DNS rebinding
            and (site is None or site == "same-origin")
            and (org is None or org == origin)
            and (site is not None or org is not None)  # a browser always sends one
        )
        if not ok:
            raise HttpError(403, "forbidden")

    def _route(self, url):
        m, p = self.command, url.path
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if m == "GET" and p == "/api/desktop":
            return self._json(200, {"desktop": True, "ffmpeg": find_ffmpeg() is not None, "maxProRes": "unlimited"})
        if m == "POST" and p == "/api/job":
            return self._json(200, {"id": self.server.new_job()})
        if m == "POST" and p == "/api/save":
            return self._save_upload(safe_name(q.get("name", "")))
        # ids and frame numbers are matched RAW (never URL-decoded) and strictly
        r = re.fullmatch(r"/api/job/([^/]+)(?:/(frame/[^/]+|encode|save))?", p)
        if not r:
            raise HttpError(404, "not found")
        job = self.server.job_dir(r.group(1))
        what = r.group(2)
        if m == "DELETE" and what is None:
            self.server.drop_job(r.group(1))
            return self._json(200, {"ok": True})
        if m == "PUT" and what and what.startswith("frame/"):
            return self._put_frame(job, what[6:])
        if m == "POST" and what == "encode":
            return self._encode(job, q.get("fps", ""))
        if m == "POST" and what == "save":
            return self._save_job(r.group(1), job, safe_name(q.get("name", "")))
        raise HttpError(404, "not found")

    # ---- helpers
    def _json(self, code: int, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body_to(self, dest: Path, limit: int, signature: bytes = b"") -> int:
        raw = self.headers.get("Content-Length")
        if raw is None or not raw.isdigit():
            raise HttpError(411, "Content-Length required")
        left = size = int(raw)
        if size > limit:
            raise HttpError(413, "body too large")
        try:
            with open(dest, "wb") as f:
                first = True
                while left:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise HttpError(400, "body ended early")
                    if first and signature and not chunk.startswith(signature):
                        raise HttpError(400, "not a PNG")
                    first = False
                    f.write(chunk)
                    left -= len(chunk)
        except BaseException:
            dest.unlink(missing_ok=True)
            raise
        if size == 0:
            dest.unlink(missing_ok=True)
            raise HttpError(400, "empty body")
        return size

    def _put_frame(self, job: Path, n: str):
        if not re.fullmatch(r"\d{1,5}", n) or int(n) > MAX_FRAME_INDEX:
            raise HttpError(400, "bad frame number")
        part = job / f"f{int(n):04d}.png.part"
        self._body_to(part, MAX_FRAME_BYTES, PNG_SIGNATURE)
        os.replace(part, job / f"f{int(n):04d}.png")  # a half-written frame is never visible to ffmpeg
        self._json(200, {"ok": True})

    def _encode(self, job: Path, fps: str):
        if not re.fullmatch(r"\d{1,3}(\.\d{1,3})?", fps) or not 0 < float(fps) <= 240:
            raise HttpError(400, "bad fps")
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise HttpError(500, "ffmpeg was not found")
        have = {int(f.name[1:-4]) for f in job.iterdir() if re.fullmatch(r"f\d{4,5}\.png", f.name)}
        if not have:
            raise HttpError(400, "no frames to encode")
        gap = next((i for i in range(len(have)) if i not in have), None)
        if gap is not None:
            raise HttpError(400, f"frame {gap} is missing")
        out = job / "out.mov"
        out.unlink(missing_ok=True)
        try:
            run = subprocess.run(
                encode_argv(ffmpeg, fps), cwd=job, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                creationflags=CREATE_NO_WINDOW, timeout=ENCODE_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            raise HttpError(500, "ffmpeg timed out")
        if run.returncode != 0 or not out.exists():
            tail = run.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
            raise HttpError(500, f"ffmpeg failed (exit {run.returncode}): {' | '.join(tail)}")
        self._json(200, {"ok": True, "bytes": out.stat().st_size, "frames": len(have)})

    def _save_job(self, job_id: str, job: Path, name: str):
        out = job / "out.mov"
        if not out.exists():
            raise HttpError(400, "nothing encoded yet")
        dest = self.server.deliver(out, name)
        if dest is None:
            return self._json(200, {"ok": True, "cancelled": True})
        self.server.drop_job(job_id)
        self._json(200, {"ok": True, "path": dest})

    def _save_upload(self, name: str):
        tmp = self.server.work_root / f"upload-{secrets.token_hex(8)}"
        try:
            self._body_to(tmp, MAX_SAVE_BYTES)
            dest = self.server.deliver(tmp, name)
        finally:
            tmp.unlink(missing_ok=True)
        self._json(200, {"ok": True, "cancelled": True} if dest is None else {"ok": True, "path": dest})


class ReliefServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, static_root: Path, pick_path=None):
        super().__init__(("127.0.0.1", 0), Handler)
        self.static_root = Path(static_root)
        self.token = secrets.token_urlsafe(24)
        self.pick_path = pick_path  # name -> chosen full path, or None if cancelled (the native dialog)
        _sweep_old_temp()
        self.work_root = Path(tempfile.mkdtemp(prefix="relief-desktop-"))
        self._jobs: set[str] = set()
        self._lock = threading.Lock()  # the job table
        self._dialog = threading.Lock()  # one Save dialog at a time
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}/?desktop={self.token}"

    def new_job(self) -> str:
        with self._lock:
            if len(self._jobs) >= MAX_JOBS:
                raise HttpError(429, "too many open exports")
            jid = secrets.token_hex(8)
            (self.work_root / jid).mkdir()
            self._jobs.add(jid)
            return jid

    def job_dir(self, jid: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{16}", jid):
            raise HttpError(400, "bad job id")
        if jid not in self._jobs:
            raise HttpError(404, "no such job")
        return self.work_root / jid

    def drop_job(self, jid: str):
        with self._lock:
            self._jobs.discard(jid)
        shutil.rmtree(self.work_root / jid, ignore_errors=True)

    def deliver(self, src: Path, name: str) -> str | None:
        """Copy a finished file to where the user wants it; None if they cancel."""
        test_dir = os.environ.get("RELIEF_SAVE_DIR")  # the self-test's stand-in for the dialog
        if test_dir:
            dest = Path(test_dir) / name
        else:
            with self._dialog:
                chosen = self.pick_path(name) if self.pick_path else None
            if not chosen:
                return None
            dest = Path(chosen)
            if not dest.suffix:
                dest = dest.with_suffix(Path(name).suffix)
        shutil.copyfile(src, dest)
        return str(dest)

    def start(self):
        self._thread = threading.Thread(target=self.serve_forever, daemon=True)
        self._thread.start()

    def close(self):
        """Stop serving and delete every job (and anything else we spooled)."""
        if self._thread:  # shutdown() waits forever on a loop that never ran
            self.shutdown()
        self.server_close()
        shutil.rmtree(self.work_root, ignore_errors=True)


def _sweep_old_temp():
    """A crash or kill leaves its job folders (GBs of PNGs) behind: drop day-old ones."""
    cutoff = time.time() - 24 * 3600
    for d in glob.glob(os.path.join(tempfile.gettempdir(), "relief-desktop-*")):
        try:
            if os.path.getmtime(d) < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def dist_dir() -> Path:
    root = Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent
    return root / "app" / "dist"


def make_server(static_root: Path | None = None, pick_path=None) -> ReliefServer:
    """The server without a window (the self-test uses this)."""
    return ReliefServer(static_root or dist_dir(), pick_path)


# ------------------------------------------------------------------ the window
def _log_path() -> Path:
    d = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "RELIEF"
    d.mkdir(parents=True, exist_ok=True)
    return d / "app.log"


def window_picker(window, start_dir: str = ""):
    """The native Save dialog, as a ReliefServer.pick_path. It reopens where the last save went."""
    import webview

    last_dir = [start_dir]

    def pick(name: str) -> str | None:
        ext = Path(name).suffix
        types = (f"{ext[1:].upper()} file (*{ext})", "All files (*.*)") if re.fullmatch(r"\.\w{1,8}", ext) else ()
        res = window.create_file_dialog(webview.FileDialog.SAVE, directory=last_dir[0], save_filename=name, file_types=types)
        path = res[0] if isinstance(res, (list, tuple)) and res else res
        if not path:
            return None
        last_dir[0] = os.path.dirname(path)
        return str(path)

    return pick


def main() -> int:
    if sys.stdout is None or sys.stderr is None:  # windowed exe: no console streams
        stream = open(_log_path(), "a", encoding="utf-8", buffering=1)
        sys.stdout, sys.stderr = sys.stdout or stream, sys.stderr or stream
    import webview  # deferred: the self-test never needs it

    if not (dist_dir() / "index.html").exists():
        raise SystemExit("app/dist is missing. Build it first: pnpm build:app")
    server = make_server()
    server.start()
    window = webview.create_window("RELIEF", server.url, width=1360, height=860, min_size=(960, 640), resizable=True, background_color="#121212")
    server.pick_path = window_picker(window)
    try:
        webview.start()  # returns when the window is closed
    finally:
        server.close()
    return 0


def run() -> int:
    try:
        return main()
    except Exception:
        with open(_log_path(), "a", encoding="utf-8") as f:
            f.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n{traceback.format_exc()}")
        raise


if __name__ == "__main__":
    sys.exit(run())
