#!/bin/bash
# Run on the new Lightsail instance after bootstrap. Runtime configuration and
# the initial database must be transferred separately through authenticated SSH.
set -euo pipefail
node_version=v24.22.2
archive="node-${node_version}-linux-x64.tar.xz"
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
cd "$directory"
curl -fsSLO "https://nodejs.org/dist/${node_version}/${archive}"
curl -fsSLO "https://nodejs.org/dist/${node_version}/SHASUMS256.txt"
if [ -f /etc/dealoop/node-release-keys.gpg ]; then
  curl -fsSLO "https://nodejs.org/dist/${node_version}/SHASUMS256.txt.asc"
  gpgv --keyring /etc/dealoop/node-release-keys.gpg SHASUMS256.txt.asc SHASUMS256.txt
else
  echo "WARNING: /etc/dealoop/node-release-keys.gpg is missing; skipping checksum-signature verification (see README)." >&2
fi
grep " ${archive}$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$archive" --strip-components=1 -C /usr/local
test -f /var/lib/dealoop/bootstrap-ready
release="/opt/dealoop/releases/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$release"
tar --no-same-owner -xzf /home/ubuntu/release.tar.gz -C "$release"
chown -R root:root "$release"
chmod -R a+rX "$release"
ln -sfn "$release" /opt/dealoop/current
systemctl daemon-reload
systemctl enable --now dealoop.service
systemctl enable --now dealoop-backup.timer
systemctl enable --now caddy.service
systemctl reload caddy.service
