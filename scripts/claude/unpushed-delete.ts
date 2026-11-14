import { readFileSync } from 'node:fs';
import { decide } from '../../src/hook/unpushed-delete.ts';

// PreToolUse hook entry for Bash (logic: src/hook/unpushed-delete.ts).
function main() {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const reason = decide(payload);
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  }
}
if (import.meta.main) main();
