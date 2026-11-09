// A POSIX sh `systemctl` for worker fixtures: it appends its argv as one JSON
// array line to `log` and reports an inactive scope. A node stub cost about
// 100 ms of startup per call (56 calls in hardening-git); sh costs about 10 ms.
// `onStop` is sh run for `systemctl --user stop <unit>` after the log line.
export function systemctlStub(log: string, onStop = ''): string {
  return `#!/bin/sh
case "$*" in *'"'*|*'\\'*) echo "systemctl stub: argv needs JSON escaping" >&2; exit 70;; esac
{ printf '['; sep=; for a in "$@"; do printf '%s"%s"' "$sep" "$a"; sep=,; done; printf ']\\n'; } >> ${shellQuote(log)}
${onStop ? `if [ "$2" = stop ]; then\n${onStop}\nfi\n` : ''}printf 'ActiveState=inactive\\nControlGroup=\\n'
`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
