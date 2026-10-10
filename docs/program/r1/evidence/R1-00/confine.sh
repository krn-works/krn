#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: confine.sh <task-worktree> <task-run-dir> [--runtime-max-sec N] -- <command...>" >&2
  exit 2
}
[[ $# -ge 4 ]] || usage
wt=$(realpath -e -- "$1") || usage
run_dir=$(realpath -e -- "$2") || usage
shift 2
runtime=2700
if [[ ${1:-} == --runtime-max-sec ]]; then
  [[ $# -ge 3 && $2 =~ ^[1-9][0-9]*$ ]] || usage
  runtime=$2
  shift 2
fi
[[ ${1:-} == -- ]] || usage
shift
[[ $# -gt 0 ]] || usage

repo=/mnt/storage/coding/krn/active/krn
node_bin=/home/krn/.local/share/mise/installs/node/24.21.0/bin
codex_home=/home/krn/.codex
codex_release="$codex_home/packages/app-server-daemon/releases/0.160.0-x86_64-unknown-linux-musl"
[[ -d "$wt" && -d "$run_dir" ]] || { echo 'task paths must be existing directories' >&2; exit 2; }
case "$wt" in "$repo"/.krn/worktrees/*) ;; *) echo 'task worktree must be under the active repo .krn/worktrees' >&2; exit 2;; esac
case "$run_dir" in "$repo"/.krn/runs/*) ;; *) echo 'task run dir must be under the active repo .krn/runs' >&2; exit 2;; esac
[[ "$wt" != "$run_dir" && "$wt" != "$run_dir"/* && "$run_dir" != "$wt"/* ]] || { echo 'task worktree and run dir must be disjoint' >&2; exit 2; }
[[ -x /usr/bin/bwrap && -x /usr/bin/systemd-run ]] || { echo 'bwrap and systemd-run are required' >&2; exit 127; }
[[ -x "$node_bin/node" ]] || { echo 'pinned Node 24.21.0 is unavailable' >&2; exit 127; }

uid=$(id -u)
nonce=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
unit="krn-confine-${uid}-$$-${nonce}.scope"

# A fresh writable CODEX_HOME overlay gets only the pinned CLI package and its
# own authentication/config files. Session/log/cache writes stay in this tmpfs.
args=(
  --ro-bind / / 
  --dev /dev
  --proc /proc
  --tmpfs /tmp
  --chmod 1777 /tmp
  --tmpfs "$codex_home"
  --dir "$codex_home/packages"
  --dir "$codex_home/packages/app-server-daemon"
  --dir "$codex_home/packages/app-server-daemon/releases"
  --ro-bind "$codex_release" "$codex_release"
  --dir "$codex_home/sessions"
  --dir "$codex_home/log"
  --dir "$codex_home/tmp"
)
# The CLI reads these for authentication and operator settings. Do not expose
# sibling Codex databases, histories, credentials, plugins, or prior sessions.
if [[ -f "$codex_home/auth.json" ]]; then
  exec {auth_fd}<"$codex_home/auth.json"
  args+=(--ro-bind-data "$auth_fd" "$codex_home/auth.json")
fi
# Secret-bearing CLI directories are replaced with empty private tmpfs mounts.
hidden=(
  /home/krn/.paperclip
  /home/krn/.config/gh
  /home/krn/.config/krn
  /home/krn/.config/paperclip
  /home/krn/.local/share/krn
  /home/krn/.local/state/krn
)
for path in "${hidden[@]}"; do
  if [[ -d "$path" ]]; then args+=(--tmpfs "$path"); fi
done
# Each allowed host write is deliberately narrow and independently named.
args+=(--bind "$wt" "$wt" --bind "$run_dir" "$run_dir")

# TERM is the only caller-provided value carried through; all other inherited
# variables, including credentials and proxy configuration, are discarded.
term=${TERM:-dumb}
[[ "$term" =~ ^[A-Za-z0-9._+-]{1,64}$ ]] || term=dumb
clean_path="$node_bin:/usr/bin:/bin"
export_path="$clean_path"

exec /usr/bin/systemd-run --user --scope --quiet \
  --unit "$unit" --property="RuntimeMaxSec=${runtime}s" -- \
  /usr/bin/bwrap "${args[@]}" \
    --clearenv \
    --setenv HOME /home/krn \
    --setenv CODEX_HOME "$codex_home" \
    --setenv PATH "$export_path" \
    --setenv LANG C.UTF-8 \
    --setenv TERM "$term" \
    --setenv KRN_CONFINE_SCOPE_UNIT "$unit" \
    --setenv KRN_CONFINE_REPO "$repo" \
    --setenv KRN_CONFINE_HIDDEN_PATHS "${hidden[*]}" \
    --chdir "$wt" --die-with-parent -- "$@"
