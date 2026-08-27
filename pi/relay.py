#!/usr/bin/env python3
"""
LoopTube audio relay, the version that runs at home.

The Cloudflare worker does the same job but from a datacenter, and googlevideo refuses
datacenter addresses for anything geo-restricted — see the README. This one runs on a
residential connection, which is the whole point of it: the same signed URL that 403s in
Frankfurt is served here.

Standard library only, deliberately. This is a Raspberry Pi Model B: one ARMv6 core and
474 MB of RAM, so the audio is streamed straight through in chunks and never buffered.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("LOOPTUBE_PORT", "8787"))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

VIDEO_ID = re.compile(r"^[\w-]{11}$")

# googlevideo n-throttles a whole-file GET to a trickle but serves ranges at full speed,
# so the file is always pulled as a sequence of ranges.
CHUNK = 1 << 20
PROBE = 65535

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Range,Content-Type",
    "Access-Control-Expose-Headers": (
        "Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Duration,X-Title,X-Format,X-Resolver"
    ),
}


def _open(url: str, headers: dict[str, str], timeout: int = 30):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)


def resolve(video_id: str) -> dict:
    """Ask the resolver for signed audio URLs. It speaks SABR so we do not have to."""
    body = json.dumps({"url": f"https://www.youtube.com/watch?v={video_id}"}).encode()
    request = urllib.request.Request(
        "https://www.clipto.com/api/youtube",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": UA},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)

    formats = [
        {"url": m["url"], "ext": m.get("ext", ""), "bitrate": int(m.get("bitrate") or 0)}
        for m in payload.get("medias", [])
        if m.get("type") == "audio" and m.get("url")
    ]
    if not formats:
        raise RuntimeError("resolver returned no audio formats")
    formats.sort(key=lambda f: f["bitrate"])
    return {"title": payload.get("title", ""), "duration": int(payload.get("duration") or 0), "formats": formats}


def pick(formats: list[dict], prefer: str | None) -> dict:
    """`safe` is m4a, which every Safari decodes; otherwise the cheapest stream."""
    if prefer == "safe":
        return next((f for f in formats if f["ext"] == "m4a"), formats[-1])
    return formats[0]


def probe(url: str) -> tuple[int, str]:
    """Fetch a real chunk, not one byte: a URL can serve `0-0` and refuse the next range."""
    with _open(url, {"User-Agent": UA, "Range": f"bytes=0-{PROBE}"}) as response:
        first = response.read()
        if len(first) < 1024:
            raise RuntimeError("upstream returned an empty body")
        content_range = response.headers.get("Content-Range", "")
        total = int(content_range.split("/")[-1]) if "/" in content_range else 0
        if not total:
            raise RuntimeError("upstream gave no length")
        return total, response.headers.get("Content-Type", "audio/mp4")


class Handler(BaseHTTPRequestHandler):
    server_version = "LoopTubePi"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # journald already timestamps every line
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # -- helpers ---------------------------------------------------------------
    def _send(self, code: int, headers: dict[str, str], body: bytes | None = None):
        self.send_response(code)
        for key, value in {**CORS, **headers}.items():
            self.send_header(key, value)
        if body is not None:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body is not None and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload: dict, code: int = 200):
        self._send(code, {"Content-Type": "application/json"}, json.dumps(payload).encode())

    # -- routes ----------------------------------------------------------------
    def do_OPTIONS(self):
        self._send(204, {})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        video_id = params.get("v", "")

        if path in ("/", "/health"):
            return self._json({"ok": True, "service": "looptube-pi"})

        # What the watchdog checks instead of /health. A dropped edge connection stalls an
        # audio-sized transfer while a one-line /health reply still slips through, so a
        # tiny liveness ping cannot tell a working tunnel from a broken one. This mimics an
        # audio response — a short wait for the first byte, then a sized body streamed in
        # chunks — without a YouTube round-trip, so failing it means the tunnel itself is
        # the problem.
        if path == "/probe":
            return self._probe(params)

        if not VIDEO_ID.match(video_id):
            return self._json({"error": "pass ?v=<11-character youtube id>"}, 400)

        try:
            if path == "/meta":
                meta = resolve(video_id)
                return self._json(
                    {
                        "id": video_id,
                        "title": meta["title"],
                        "duration": meta["duration"],
                        "resolver": "clipto",
                        "formats": [{"ext": f["ext"], "bitrate": f["bitrate"]} for f in meta["formats"]],
                    }
                )

            if path == "/audio":
                return self._audio(video_id, params.get("fmt"))

            return self._json({"error": "not found"}, 404)
        except urllib.error.HTTPError as e:
            return self._json({"error": f"upstream {e.code}"}, 502)
        except Exception as e:  # a relay that dies on one bad video is worse than one that reports
            return self._json({"error": str(e)[:200]}, 502)

    def _probe(self, params: dict[str, str]):
        # bounded so a stray request cannot ask the Pi to stream forever
        size = min(max(int(params.get("bytes", 262144) or 262144), 1), 4 << 20)
        delay = min(max(float(params.get("delay", 1.0) or 1.0), 0.0), 10.0)
        time.sleep(delay) # stand in for the resolve that precedes real audio's first byte
        self.send_response(200)
        headers = {"Content-Type": "application/octet-stream", "Content-Length": str(size), "Cache-Control": "no-store"}
        for key, value in {**CORS, **headers}.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command == "HEAD":
            return
        block = b"\0" * (64 * 1024)
        while size > 0:
            self.wfile.write(block[:size] if size < len(block) else block)
            size -= len(block)

    def _audio(self, video_id: str, prefer: str | None):
        meta = resolve(video_id)
        chosen = pick(meta["formats"], prefer)
        total, content_type = probe(chosen["url"])

        wanted = self._range(total)
        start, end = wanted if wanted else (0, total - 1)

        headers = {
            "Content-Type": content_type,
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
            "X-Duration": str(meta["duration"]),
            "X-Format": chosen["ext"],
            "X-Resolver": "clipto",
            "X-Title": urllib.parse.quote(meta["title"]),
            "Cache-Control": "public, max-age=86400",
        }
        if wanted:
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"

        self.send_response(206 if wanted else 200)
        for key, value in {**CORS, **headers}.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command == "HEAD":
            return

        position = start
        while position <= end:
            stop = min(position + CHUNK - 1, end)
            with _open(chosen["url"], {"User-Agent": UA, "Range": f"bytes={position}-{stop}"}, timeout=60) as upstream:
                while True:
                    block = upstream.read(64 * 1024)
                    if not block:
                        break
                    self.wfile.write(block)
                    position += len(block)

    def _range(self, total: int):
        match = re.match(r"^bytes=(\d*)-(\d*)$", self.headers.get("Range", "") or "")
        if not match or not total:
            return None
        start = int(match.group(1)) if match.group(1) else 0
        end = min(int(match.group(2)), total - 1) if match.group(2) else total - 1
        return (start, end) if start <= end else None


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"looptube relay on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
