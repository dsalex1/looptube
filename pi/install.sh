#!/usr/bin/env bash
# Install the LoopTube relay and its tunnel on a Debian-ish SBC. Idempotent: safe to
# re-run to upgrade. Touches nothing outside /opt/looptube and its two units.
set -euo pipefail

DIR=/opt/looptube
SECRET=${LOOPTUBE_SECRET:?set LOOPTUBE_SECRET to the worker registration secret}
WORKER=${LOOPTUBE_WORKER:-https://looptube-audio.dsalex.workers.dev}
ARCH=$(uname -m)

case "$ARCH" in
  armv6l | armv7l) CFD_ARCH=arm ;;
  aarch64 | arm64) CFD_ARCH=arm64 ;;
  x86_64) CFD_ARCH=amd64 ;;
  *) echo "unsupported architecture $ARCH" >&2; exit 1 ;;
esac

install -d "$DIR"
install -m 755 relay.py tunnel.py "$DIR/"

if [ ! -x /usr/local/bin/cloudflared ]; then
  echo "fetching cloudflared for $CFD_ARCH"
  curl -fsSL --retry 3 -o /tmp/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CFD_ARCH"
  install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared
fi

# the secret never lands in a unit file or in `ps`, so it stays out of journald too
umask 077
cat > "$DIR/env" <<EOF
LOOPTUBE_SECRET=$SECRET
LOOPTUBE_WORKER=$WORKER
LOOPTUBE_PORT=8787
EOF
umask 022

cat > /etc/systemd/system/looptube-relay.service <<'EOF'
[Unit]
Description=LoopTube audio relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/opt/looptube/env
ExecStart=/usr/bin/python3 /opt/looptube/relay.py
Restart=always
RestartSec=5
# a Pi Model B has 474 MB in total; the relay streams, so it should never approach this
MemoryMax=128M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/looptube-tunnel.service <<'EOF'
[Unit]
Description=LoopTube tunnel and registration
After=network-online.target looptube-relay.service
Wants=network-online.target
BindsTo=looptube-relay.service

[Service]
Type=simple
EnvironmentFile=/opt/looptube/env
ExecStart=/usr/bin/python3 /opt/looptube/tunnel.py
# A new tunnel means a new hostname, which is announced on start — so restarting is a
# complete recovery from a dropped tunnel, a rebooted Pi or a changed WAN address.
Restart=always
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now looptube-relay.service looptube-tunnel.service
systemctl restart looptube-relay.service looptube-tunnel.service

echo "installed; waiting for the tunnel to announce itself"
sleep 12
systemctl --no-pager --lines=12 status looptube-tunnel.service || true
