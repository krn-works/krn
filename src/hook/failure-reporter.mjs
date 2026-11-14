// node --test reporter for the Stop hook (src/hook/stop.ts): one JSON line per failing test, {"file": <path relative to cwd>, "name": <test name>}.
// A file that fails to load or exits nonzero is reported under its own file name.
import { relative } from 'node:path';

export default async function* failureReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { file, name } = event.data;
    if (typeof file !== 'string') continue;
    yield `${JSON.stringify({ file: relative(process.cwd(), file), name })}\n`;
  }
}
