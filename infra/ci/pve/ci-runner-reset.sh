#!/bin/sh
# SSH forced command. Install only after the explicit host grant.
# No caller argument is forwarded and stdin is a bounded JSON reset request.
set -eu
if [ -n "${SSH_ORIGINAL_COMMAND-}" ]; then
  printf '%s\n' 'SSH_COMMAND_FORBIDDEN' >&2
  exit 64
fi
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C \
  /usr/local/libexec/ci-platform reset serve --execute \
  --manifest /etc/ci-platform/runner.json --state-dir /var/lib/ci-platform
