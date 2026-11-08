import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// These programs and their data are copied into an evaluator-owned directory,
// then mounted read-only by mask. No program reads the candidate package.json.
export async function writeCheckTools(
  directory: string,
  node: string,
  scripts: Record<string, string>,
): Promise<void> {
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(directory, 'scripts.json'), JSON.stringify(scripts));
  await writeFile(
    join(directory, 'npm'),
    `#!/usr/bin/sh\nexec ${shellQuote(node)} ${shellQuote(join(directory, 'npm.mjs'))} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, 'npm.mjs'),
    `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const scripts = JSON.parse(readFileSync(join(directory, 'scripts.json'), 'utf8'));
const args = process.argv.slice(2);
const command = args.shift();
let name;
if (command === 'test' || command === 't') name = 'test';
else if (command === 'run' || command === 'run-script') name = args.shift();
else {
  process.stderr.write('npm subcommand not allowed: ' + (command ?? '(none)') + '\\n');
  process.exit(127);
}
if (!Object.hasOwn(scripts, name)) {
  process.stderr.write('script not frozen: ' + (name ?? '(none)') + '\\n');
  process.exit(127);
}
if (args[0] === '--') args.shift();
const quote = (value) => "'" + value.replaceAll("'", "'\\\\''") + "'";
// Shell functions keep nested npm/npx calls on the evaluator shim even when
// a package provides executables with those names in node_modules/.bin.
const functions = 'npm() { ' + quote(join(directory, 'npm')) + ' "$@"; }; npx() { ' + quote(join(directory, 'npx')) + ' "$@"; }; ';
const text = functions + scripts[name] + (args.length ? ' ' + args.map(quote).join(' ') : '');
const child = spawn('/usr/bin/sh', ['-c', text], {
  stdio: 'inherit',
  env: { ...process.env, PATH: join(process.cwd(), 'node_modules/.bin') + ':' + process.env.PATH },
});
child.on('error', (error) => { process.stderr.write(error.message + '\\n'); process.exitCode = 127; });
child.on('close', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 127; });
`,
  );
  await writeFile(
    join(directory, 'npx'),
    `#!/usr/bin/sh
printf 'npx is disabled for frozen checks\\n' >&2
exit 127
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, 'runner.mjs'),
    `import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
const [marker, cwd, path, ...argv] = process.argv.slice(2);
// This private prefix distinguishes mask setup failures from check exits,
// including a check whose genuine exit code is 64, 65 or 70. It is removed
// before stderr is hashed; command bytes are never decoded and re-encoded.
writeSync(2, marker);
process.chdir(cwd);
const child = spawn(argv[0], argv.slice(1), {
  stdio: 'inherit', env: { ...process.env, PATH: path, NODE_OPTIONS: '--test-reporter=tap' },
});
child.on('error', (error) => { process.stderr.write(error.message + '\\n'); process.exitCode = 127; });
child.on('close', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 127; });
`,
  );
}
