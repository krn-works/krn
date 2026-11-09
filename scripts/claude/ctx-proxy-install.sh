#!/usr/bin/env bash
# Install and start the ctx-proxy systemd user unit from the main checkout.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
root="$(dirname "$common")"
port="${KRN_CTX_PROXY_PORT:-47318}"
node_bin="$(command -v node)"
test -f "$root/scripts/claude/ctx-proxy.ts" || { echo "no ctx-proxy.ts in $root" >&2; exit 1; }
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir"
sed -e "s|@ROOT@|$root|" -e "s|@NODE@|$node_bin|" -e "s|@PORT@|$port|" \
  "$here/krn-ctx-proxy.service" > "$unit_dir/krn-ctx-proxy.service"
systemctl --user daemon-reload
systemctl --user enable --now krn-ctx-proxy.service
systemctl --user restart krn-ctx-proxy.service
echo "krn-ctx-proxy on 127.0.0.1:$port from $root"
