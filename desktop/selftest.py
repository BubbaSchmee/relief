"""Self-test for the desktop app's local server, with no window.

  desktop\\.venv\\Scripts\\python.exe desktop\\selftest.py

Starts the real server, drives it over HTTP like the app does (30 synthetic RGBA
frames -> native ProRes 4444 -> "save"), then checks the file with ffprobe and by
decoding it. Prints PASS/FAIL per check; exit code 1 if any failed.
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import relief_desktop as rd  # noqa: E402

W, H, FRAMES, FPS = 256, 144, 30, 30
SQ, SQ_Y = 48, 48
COLOUR = (255, 46, 154)  # an opaque pink square on a transparent frame
results: list[bool] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    return bool(ok)


def square_x(i: int) -> int:
    return 20 + 4 * i  # the square moves, so frame order is checked too


def make_png(i: int) -> bytes:
    """One straight-RGBA PNG, written with zlib only."""
    px = bytearray(W * H * 4)  # all zero: transparent
    for y in range(SQ_Y, SQ_Y + SQ):
        for x in range(square_x(i), square_x(i) + SQ):
            px[(y * W + x) * 4 : (y * W + x) * 4 + 4] = bytes((*COLOUR, 255))
    raw = b"".join(b"\0" + bytes(px[y * W * 4 : (y + 1) * W * 4]) for y in range(H))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return rd.PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 1)) + chunk(b"IEND", b"")


class Client:
    def __init__(self, server: rd.ReliefServer):
        self.port, self.token = server.server_port, server.token

    def call(self, method: str, path: str, body: bytes | None = None, *, token: str | None = "", headers: dict | None = None, origin: bool = True):
        h = {"Host": f"127.0.0.1:{self.port}"}
        if token is not None:
            h["X-Relief-Token"] = self.token if token == "" else token
        if origin:
            h["Origin"] = f"http://127.0.0.1:{self.port}"
            h["Sec-Fetch-Site"] = "same-origin"
        h.update(headers or {})
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=300)
        try:
            c.request(method, path, body=body, headers=h)
            r = c.getresponse()
            data = r.read()
            try:
                return r.status, json.loads(data)
            except ValueError:
                return r.status, data
        finally:
            c.close()


def tool(*args: str) -> bytes:
    return subprocess.run(args, check=True, capture_output=True, creationflags=rd.CREATE_NO_WINDOW).stdout


def main() -> int:
    ffmpeg, ffprobe = rd.find_ffmpeg(), rd.find_ffprobe()
    check("ffmpeg and ffprobe found", bool(ffmpeg and ffprobe))
    if not (ffmpeg and ffprobe):
        return 1

    static = Path(tempfile.mkdtemp(prefix="relief-selftest-static-"))
    (static / "index.html").write_text("<!doctype html><title>x</title>")
    (static / "a.js").write_text("export {}")
    (static / "empty").mkdir()
    out_dir = Path(tempfile.mkdtemp(prefix="relief-selftest-out-"))
    srv = rd.make_server(static)
    srv.start()
    c = Client(srv)
    work = srv.work_root
    os.environ.pop("RELIEF_SAVE_DIR", None)
    try:
        # ---- who may call the API
        s, _ = c.call("GET", "/api/desktop", token=None)
        check("GET /api/desktop without token -> 403", s == 403, f"got {s}")
        s, _ = c.call("GET", "/api/desktop", token="wrong")
        check("GET /api/desktop with a wrong token -> 403", s == 403, f"got {s}")
        s, _ = c.call("GET", "/api/desktop", headers={"Origin": "http://evil.example", "Sec-Fetch-Site": "cross-site"})
        check("right token but cross-origin page -> 403", s == 403, f"got {s}")
        s, _ = c.call("GET", "/api/desktop", origin=False)
        check("right token but no Origin / Sec-Fetch-Site -> 403", s == 403, f"got {s}")
        s, _ = c.call("GET", "/api/desktop", headers={"Host": "evil.example"})
        check("right token but a foreign Host (DNS rebinding) -> 403", s == 403, f"got {s}")
        s, _ = c.call("OPTIONS", "/api/job", token=None)
        check("CORS preflight is refused", s == 403, f"got {s}")
        s, body = c.call("GET", "/api/desktop")
        check("GET /api/desktop with token -> desktop, ffmpeg, unlimited ProRes", s == 200 and body == {"desktop": True, "ffmpeg": True, "maxProRes": "unlimited"}, f"{s} {body}")

        # ---- static files need no token
        s, body = c.call("GET", "/", token=None, origin=False)
        check("static index.html needs no token", s == 200 and b"<title>x</title>" in body, f"got {s}")
        conn = http.client.HTTPConnection("127.0.0.1", srv.server_port)
        conn.request("GET", "/a.js")
        r = conn.getresponse()
        r.read()
        check("static .js is served as JavaScript", r.status == 200 and "javascript" in r.getheader("Content-Type", ""), r.getheader("Content-Type", ""))
        conn.request("GET", "/empty/")
        r = conn.getresponse()
        r.read()
        check("no directory listings", r.status == 404, f"got {r.status}")
        conn.request("GET", "/../relief_desktop.py")
        r = conn.getresponse()
        r.read()
        check("static path traversal does not leave the app folder", r.status in (301, 400, 404), f"got {r.status}")
        conn.close()

        # ---- a ProRes job
        s, body = c.call("POST", "/api/job", b"")
        jid = body.get("id", "") if isinstance(body, dict) else ""
        check("POST /api/job -> id, folder created", s == 200 and len(jid) == 16 and (work / jid).is_dir(), f"{s} {body}")

        for label, path in (
            ("id ../x", "/api/job/../x/frame/0"),
            ("frame ../../x", f"/api/job/{jid}/frame/../../x"),
            ("encoded id", "/api/job/%2e%2e%2fx/frame/0"),
            ("encoded frame", f"/api/job/{jid}/frame/%2e%2e%2fx"),
            ("negative frame", f"/api/job/{jid}/frame/-1"),
            ("huge frame", f"/api/job/{jid}/frame/100000"),
            ("unknown job", "/api/job/0123456789abcdef/frame/0"),
        ):
            s, _ = c.call("PUT", path, make_png(0))
            check(f"PUT frame with {label} is rejected", s in (400, 404), f"got {s}")
        check("no file was written anywhere by those attempts", sorted(p.name for p in work.iterdir()) == [jid] and not list((work / jid).iterdir()))
        s, _ = c.call("PUT", f"/api/job/{jid}/frame/0", b"this is not a png")
        check("PUT a non-PNG body is rejected", s == 400, f"got {s}")
        conn = http.client.HTTPConnection("127.0.0.1", srv.server_port)
        conn.putrequest("PUT", f"/api/job/{jid}/frame/0", skip_host=True)
        for k, v in (("Host", f"127.0.0.1:{srv.server_port}"), ("X-Relief-Token", srv.token), ("Origin", f"http://127.0.0.1:{srv.server_port}"), ("Content-Length", str(10**10))):
            conn.putheader(k, v)
        conn.endheaders()
        r = conn.getresponse()
        r.read()
        check("an oversized body is rejected before it is read", r.status == 413, f"got {r.status}")
        conn.close()
        s, _ = c.call("POST", f"/api/job/{jid}/encode?fps=30")
        check("encode with no frames -> error", s == 400, f"got {s}")

        ok = True
        for i in range(FRAMES):
            s, _ = c.call("PUT", f"/api/job/{jid}/frame/{i}", make_png(i))
            ok &= s == 200
        check(f"PUT {FRAMES} synthetic RGBA PNG frames", ok and len(list((work / jid).glob("f*.png"))) == FRAMES)

        s, body = c.call("POST", f"/api/job/{jid}/encode?fps=abc")
        check("encode with a bad fps -> 400", s == 400, f"got {s}")
        s, body = c.call("POST", f"/api/job/{jid}/encode?fps={FPS}")
        check("encode at 30 fps -> ok, bytes", s == 200 and body.get("ok") and body.get("bytes", 0) > 0, f"{s} {body}")

        # cancelling the Save dialog keeps the encoded file
        srv.pick_path = lambda name: None
        s, body = c.call("POST", f"/api/job/{jid}/save?name=clip.mov")
        check("cancelled Save dialog -> cancelled, job kept", s == 200 and body.get("cancelled") is True and (work / jid / "out.mov").exists(), f"{s} {body}")

        os.environ["RELIEF_SAVE_DIR"] = str(out_dir)
        s, body = c.call("POST", f"/api/job/{jid}/save?name=selftest_clip.mov")
        mov = out_dir / "selftest_clip.mov"
        check("save writes the .mov and returns its path", s == 200 and Path(body.get("path", "")) == mov and mov.stat().st_size > 0, f"{s} {body}")
        check("saving deletes the job folder", not (work / jid).exists())

        # ---- what is in the file
        probe = json.loads(tool(ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0", "-of", "json", "-show_entries",
                                "stream=codec_name,profile,pix_fmt,width,height,color_space,color_primaries,color_transfer,nb_read_frames", str(mov)))["streams"][0]
        check("codec is prores", probe.get("codec_name") == "prores", probe.get("codec_name"))
        check("profile is 4444", probe.get("profile") == "4444", probe.get("profile"))
        check("30 frames", probe.get("nb_read_frames") == str(FRAMES), probe.get("nb_read_frames"))
        check(f"size is {W}x{H}", (probe.get("width"), probe.get("height")) == (W, H))
        check("stream colour tags are bt709", (probe.get("color_space"), probe.get("color_primaries"), probe.get("color_transfer")) == ("bt709",) * 3,
              f"{probe.get('color_space')}/{probe.get('color_primaries')}/{probe.get('color_transfer')}")
        frame0 = json.loads(tool(ffprobe, "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_frames", "-of", "json", "-show_entries",
                                 "frame=color_space,color_primaries,color_transfer,pix_fmt", str(mov)))["frames"][0]
        check("decoded frame header colour is bt709 (the prores_metadata fix)", (frame0.get("color_space"), frame0.get("color_primaries"), frame0.get("color_transfer")) == ("bt709",) * 3,
              f"{frame0.get('color_space')}/{frame0.get('color_primaries')}/{frame0.get('color_transfer')}")
        check("pixel format carries alpha", "a" in probe.get("pix_fmt", "").split("p")[0], probe.get("pix_fmt"))

        raw = tool(ffmpeg, "-v", "error", "-i", str(mov), "-f", "rawvideo", "-pix_fmt", "rgba", "-")
        check("decodes to 30 RGBA frames", len(raw) == W * H * 4 * FRAMES, f"{len(raw)} bytes")
        worst_colour, bad_corner, bad_order = 0, 0, 0
        for i in range(min(FRAMES, len(raw) // (W * H * 4))):
            f = raw[i * W * H * 4 : (i + 1) * W * H * 4]
            at = lambda x, y: f[(y * W + x) * 4 : (y * W + x) * 4 + 4]
            for cx, cy in ((0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)):
                bad_corner += at(cx, cy)[3] != 0
            r, g, b, a = at(square_x(i) + SQ // 2, SQ_Y + SQ // 2)
            worst_colour = max(worst_colour, abs(r - COLOUR[0]), abs(g - COLOUR[1]), abs(b - COLOUR[2]), 255 - a)
            bad_order += at(square_x(i) - 6, SQ_Y + SQ // 2)[3] != 0  # just left of the square: must be empty
        check("corner pixels have alpha 0 in every frame", bad_corner == 0, f"{bad_corner} non-transparent")
        check("square colour preserved within 2/255 in every frame", worst_colour <= 2, f"worst error {worst_colour}/255")
        check("frames are in order (the square moves right)", bad_order == 0, f"{bad_order} out of place")

        # ---- the other export path
        blob = os.urandom(5000)
        s, body = c.call("POST", "/api/save?name=model.glb", blob)
        check("POST /api/save writes the bytes", s == 200 and (out_dir / "model.glb").read_bytes() == blob, f"{s} {body}")
        s, body = c.call("POST", "/api/save?name=../../evil.bin", b"x")
        check("a path in the file name cannot escape the save folder", s == 200 and Path(body["path"]).parent == out_dir and not (out_dir.parent / "evil.bin").exists(), f"{s} {body}")
        s, _ = c.call("POST", "/api/save?name=", b"x")
        check("an empty file name is rejected", s == 400, f"got {s}")
        s, body = c.call("POST", "/api/job", b"")
        s2, _ = c.call("DELETE", f"/api/job/{body['id']}")
        check("DELETE job removes its folder", s2 == 200 and not (work / body["id"]).exists())
    finally:
        srv.close()
        shutil.rmtree(static, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)
    check("closing the server deletes the working folder", not work.exists())
    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
