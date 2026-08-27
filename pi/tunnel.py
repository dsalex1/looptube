#!/usr/bin/env python3
"""
Put the local relay on the public internet and tell the worker where it landed.

A quick tunnel needs no Cloudflare account and no domain, but it is handed a fresh
hostname every time it starts. Rather than fight that, the address is treated as
something that changes: cloudflared is started here, its assigned hostname is read out
of its own log, and that hostname is announced to the worker. A restart — of this
service, of the Pi, or of the household's IP address — is then just another
announcement, and nothing has to be reconfigured anywhere.

The part that is not obvious: when the edge connection drops, Cloudflare retires the
hostname, but cloudflared reconnects the *tunnel* and carries on reporting itself
healthy. The old name then answers 530 forever and nothing downstream knows. So the
watchdog checks the public URL from the outside rather than the relay from the inside,
and tears the tunnel down when the name has died, which is what earns a new one.

The registration carries a short TTL, so the announcement is also the liveness signal:
stop heartbeating and the worker forgets this Pi, and the app falls back to fetching
through the worker without being told anything is wrong.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.request

WORKER = os.environ.get("LOOPTUBE_WORKER", "https://looptube-audio.dsalex.workers.dev")
SECRET = os.environ.get("LOOPTUBE_SECRET", "")
PORT = os.environ.get("LOOPTUBE_PORT", "8787")
CLOUDFLARED = os.environ.get("CLOUDFLARED", "/usr/local/bin/cloudflared")

# The worker keeps a registration for 15 minutes; re-announcing well inside that rides
# out a transient failure without the app ever seeing the Pi disappear. Kept above the
# watchdog interval because KV writes are rationed and health checks are not.
HEARTBEAT = 300
WATCHDOG = 60
# One miss is a blip — a reconnect takes about ten seconds. Three is a dead hostname.
TOLERATED_MISSES = 3
TUNNEL_URL = re.compile(rb"(https://[a-z0-9-]+\.trycloudflare\.com)")

stopping = threading.Event()


def log(message: str) -> None:
    print(message, flush=True)


# Cloudflare's edge turns away urllib's default user agent with a 1010 before the
# request ever reaches the worker, so the announcement has to look like a normal client.
UA = (
    "Mozilla/5.0 (X11; Linux armv6l) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def announce(url: str) -> bool:
    body = json.dumps({"url": url, "secret": SECRET}).encode()
    request = urllib.request.Request(
        f"{WORKER}/register",
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            json.load(response)
        return True
    except urllib.error.HTTPError as e:
        log(f"register refused: {e.code} {e.read()[:120]!r}")
    except Exception as e:
        log(f"register failed: {e}")
    return False


# The probe stands in for an audio request: a sized body the tunnel has to carry whole.
# A one-line /health reply proves the name resolves, not that it can move audio — a dropped
# edge connection stalls the transfer while the tiny reply still gets through — so the whole
# body is pulled and counted, and a short read counts as unreachable.
PROBE_BYTES = 262144
PROBE_TIMEOUT = 25


def reachable(url: str) -> bool:
    """Can the *public* name still carry an audio-sized response? /health cannot tell."""
    request = urllib.request.Request(f"{url}/probe?bytes={PROBE_BYTES}", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT) as response:
            if response.status != 200:
                return False
            got = 0
            while True:
                block = response.read(65536)
                if not block:
                    break
                got += len(block)
            return got == PROBE_BYTES
    except Exception:
        return False


def supervise(url: str, process) -> None:
    """Re-announce on a slow beat, and check the public name on a fast one."""
    misses = 0
    since_announce = 0

    while not stopping.wait(WATCHDOG):
        if reachable(url):
            misses = 0
            since_announce += WATCHDOG
            if since_announce >= HEARTBEAT:
                since_announce = 0
                if not announce(url):
                    log("heartbeat failed; will try again next interval")
            continue

        misses += 1
        log(f"{url} did not answer ({misses}/{TOLERATED_MISSES})")
        if misses >= TOLERATED_MISSES:
            log("hostname looks retired; dropping the tunnel so a fresh one is issued")
            stopping.set()
            process.terminate()
            return


def main() -> int:
    if not SECRET:
        log("LOOPTUBE_SECRET is not set; refusing to start")
        return 2

    process = subprocess.Popen(
        [
            CLOUDFLARED,
            "tunnel",
            "--no-autoupdate",
            # QUIC is the default and it pegs an ARMv6 core: the same transfer that takes
            # four seconds straight off the relay took nearly three minutes through it,
            # with the origin dropping out under the load. http2 is far cheaper here.
            "--protocol",
            "http2",
            "--url",
            f"http://127.0.0.1:{PORT}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
    )

    def shutdown(*_):
        stopping.set()
        process.terminate()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    url: str | None = None

    # cloudflared prints the assigned hostname once, early, mixed into its banner
    for raw in process.stdout:
        sys.stdout.write(raw.decode("utf-8", "replace"))
        sys.stdout.flush()
        if url:
            continue
        found = TUNNEL_URL.search(raw)
        if not found:
            continue
        url = found.group(1).decode()
        log(f"tunnel is {url}")
        if announce(url):
            log("announced to worker")
        threading.Thread(target=supervise, args=(url, process), daemon=True).start()

    code = process.wait()
    stopping.set()
    log(f"cloudflared exited with {code}; systemd will restart and a new tunnel will be announced")
    # a non-zero exit tells systemd this was a failure, which is what we want it to see
    return code or 1


if __name__ == "__main__":
    sys.exit(main())
