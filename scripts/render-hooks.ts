// Writes or checks .claude/settings.json hooks and .codex/hooks.json from src/dispatch/table.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { renderCodex, renderSettings } from '../src/dispatch/render.ts';

const root = new URL('../', import.meta.url);
const settings = new URL('.claude/settings.json', root);
const codex = new URL('.codex/hooks.json', root);

if (import.meta.main) {
  const checkOnly = process.argv.includes('--check');
  const write = process.argv.includes('--write');
  if (checkOnly === write) {
    process.stderr.write('Choose exactly one of --check or --write.\n');
    process.exitCode = 2;
  } else {
    const wanted = [
      [settings, renderSettings(readFileSync(settings, 'utf8'))],
      [codex, renderCodex()],
    ] as const;
    for (const [file, text] of wanted) {
      if (write) writeFileSync(file, text);
      else if (readFileSync(file, 'utf8') !== text) {
        process.stderr.write(
          `${file.pathname} is stale; run npm run render:hooks.\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}
