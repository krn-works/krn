#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo 'usage: qualify.sh <task-worktree> <task-run-dir>' >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
worktree=$(realpath -e -- "$1")
run_dir=$(realpath -e -- "$2")
observer="$here/observer.py"
printf '%s\n' '--- Direct observer under confine.sh ---'
set +e
"$here/confine.sh" "$worktree" "$run_dir" -- /usr/bin/python3 "$observer"
direct_status=$?
set -e
printf '%s\n' '--- Lead command for the real-agent qualification turn (not run by this script) ---'
printf '%q ' "$here/confine.sh" "$worktree" "$run_dir" -- \
  /home/krn/.codex/packages/app-server-daemon/releases/0.160.0-x86_64-unknown-linux-musl/bin/codex \
  exec -m gpt-6-luna --dangerously-bypass-approvals-and-sandbox \
  "Run exactly: python3 $observer. Echo its complete KRN_CONFINE_JSON= line verbatim. Do not run any other command."
printf '\n'
exit "$direct_status"
