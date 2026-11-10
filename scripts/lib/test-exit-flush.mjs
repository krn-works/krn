// Preloaded into every `node --test` run that uses --test-force-exit (see
// test-timeout.ts). Node's force exit calls process.exit() as soon as the
// reporter stream unpipes, while the serialized test events of the file are
// still queued for the stdout pipe; the runner then never sees the file's last
// results or its own summary. Delay the exit until stdout and stderr drained.
const exit = process.exit;
let exiting = false;

process.exit = function flushedExit(code) {
  if (exiting) return undefined;
  exiting = true;
  if (code !== undefined) process.exitCode = code;
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) exit.call(process);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
  return undefined;
};
