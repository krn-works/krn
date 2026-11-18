// node --test reporter for the Stop hook (src/hook/stop.ts): one JSON line per failing test, {"file": <path relative to cwd>, "name": <test name>}.
// A file that fails to load or exits nonzero is reported under its own file name.
// A stderr line naming a missing package, module or command is passed on as {"file", "stderr"}, so the hook can tell
// a broken environment (a base worktree without node_modules) from a red test.
import { relative } from 'node:path';

const MISSING =
  /Cannot find|not found|No module named|ModuleNotFoundError|Failed to resolve/u;

export default async function* failureReporter(source) {
  for await (const event of source) {
    const { file } = event.data ?? {};
    if (typeof file !== 'string') continue;
    if (event.type === 'test:stderr') {
      const { message } = event.data;
      if (typeof message === 'string' && MISSING.test(message))
        yield `${JSON.stringify({ file: relative(process.cwd(), file), stderr: message })}\n`;
      continue;
    }
    if (event.type !== 'test:fail') continue;
    yield `${JSON.stringify({ file: relative(process.cwd(), file), name: event.data.name })}\n`;
  }
}
