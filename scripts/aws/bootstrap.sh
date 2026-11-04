#!/bin/bash
# Lightsail may prepend a POSIX-shell launcher to user-data.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg xz-utils debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
caddy_fingerprint=$(gpg --show-keys --with-colons /usr/share/keyrings/caddy-stable-archive-keyring.gpg | awk -F: '/^fpr:/ {print $10; exit}')
echo "Caddy repository key fingerprint: ${caddy_fingerprint}"
if [ -n "${CADDY_KEY_FINGERPRINT:-}" ] && [ "${caddy_fingerprint}" != "${CADDY_KEY_FINGERPRINT}" ]; then echo "Caddy repository key fingerprint mismatch" >&2; exit 1; fi
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy
systemctl stop caddy
useradd --system --create-home --home-dir /var/lib/dealoop --shell /usr/sbin/nologin dealoop
install -d -o dealoop -g dealoop -m 700 /var/lib/dealoop/data
install -d -m 755 /opt/dealoop/releases
# The release deployment installs the pinned, checksum-verified Node LTS binary.
cat > /etc/systemd/system/dealoop.service <<'UNIT'
[Unit]
Description=DeaLoop marketplace
After=network-online.target
Wants=network-online.target
[Service]
User=dealoop
Group=dealoop
WorkingDirectory=/opt/dealoop/current
EnvironmentFile=/etc/dealoop.env
ExecStart=/usr/local/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dealoop
PrivateTmp=true
UMask=0077
MemoryMax=650M
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/dealoop-backup.service <<'UNIT'
[Unit]
Description=Verify and back up DeaLoop SQLite to private object storage
After=network-online.target
[Service]
Type=oneshot
User=dealoop
Group=dealoop
WorkingDirectory=/opt/dealoop/current
EnvironmentFile=/etc/dealoop.env
ExecStart=/usr/local/bin/node scripts/aws/backup.mjs
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dealoop
PrivateTmp=true
UMask=0077
UNIT
cat > /etc/systemd/system/dealoop-backup.timer <<'UNIT'
[Unit]
Description=Daily DeaLoop database backup
[Timer]
OnCalendar=*-*-* 09:00:00 UTC
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
UNIT
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/dealoop.conf
systemctl restart systemd-journald
systemctl daemon-reload
touch /var/lib/dealoop/bootstrap-ready
