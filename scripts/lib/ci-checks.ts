// The checks CI runs, read from the files that define them: the `lint` and `check` scripts of
// package.json, the run steps of the lint, typecheck and test jobs of .github/workflows/ci.yml, and
// the guard tests the repo contract names. No list of checks is kept anywhere else.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW = '.github/workflows/ci.yml';
const WORKFLOW_JOBS = new Set(['lint', 'typecheck', 'test']);
const TEST_FILE = /\.test\.(?:ts|js|mjs|cjs)$/u;

/** A shell command as the one check it names: `$VAR` operands and the base/head flags are dropped. */
function normalize(command: string): string {
  const out: string[] = [];
  let skipValue = false;
  for (const token of command.trim().split(/\s+/u)) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (token === '--base' || token === '--head') {
      skipValue = true;
      continue;
    }
    if (token.startsWith('"$')) continue;
    out.push(token);
  }
  return out.join(' ');
}

function scriptChecks(root: string, name: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const body = manifest.scripts?.[name];
  if (body === undefined) throw new Error(`package.json has no ${name} script`);
  return body.split('&&').map(normalize);
}

/** The commands of the run steps of the lint, typecheck and test jobs, `npm run` of a script expanded. */
function workflowChecks(root: string): string[] {
  const lines = readFileSync(join(root, WORKFLOW), 'utf8').split('\n');
  const checks: string[] = [];
  let job = '';
  let inJobs = false;
  let block = false;
  for (const line of lines) {
    if (/^jobs:/u.test(line)) inJobs = true;
    const jobHead = /^ {2}([a-z][a-z0-9-]*):\s*$/u.exec(line);
    if (inJobs && jobHead) job = jobHead[1] ?? '';
    if (!WORKFLOW_JOBS.has(job)) continue;
    const inline = /^\s+run:\s*(\S.*)$/u.exec(line);
    if (inline && inline[1] !== '|') {
      block = false;
      checks.push(normalize(inline[1] ?? ''));
      continue;
    }
    if (/^\s+run:\s*\|\s*$/u.test(line)) {
      block = true;
      continue;
    }
    if (block) {
      const command = /^\s+((?:node|npm) .*)$/u.exec(line);
      if (command) checks.push(normalize(command[1] ?? ''));
      else if (/^\s{0,7}\S/u.test(line)) block = false;
    }
  }
  const expanded = checks.flatMap((command) => {
    const script = /^npm run (lint|check)$/u.exec(command);
    return script ? scriptChecks(root, script[1] ?? '') : [command];
  });
  return expanded;
}

/** The guard tests: every test file under a directory the contract `guard` names, and each file it names. */
function guardChecks(root: string): string[] {
  const contract = JSON.parse(readFileSync(join(root, 'krn.json'), 'utf8')) as {
    guard?: string;
  };
  const files: string[] = [];
  for (const entry of (contract.guard ?? '').split(/\s+/u).filter(Boolean)) {
    const path = join(root, entry);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort())
        if (TEST_FILE.test(name))
          files.push(`${entry.replace(/\/$/u, '')}/${name}`);
    } else files.push(entry);
  }
  return files.map((file) => `node --test ${file}`);
}

/** Every check CI runs in `root`, each once, in the order lint, typecheck, workflow steps, guard tests. */
export function listCiChecks(root: string): string[] {
  const all = [
    ...scriptChecks(root, 'lint'),
    ...scriptChecks(root, 'check'),
    ...workflowChecks(root),
    ...guardChecks(root),
  ];
  return [...new Set(all)];
}

/** The command a record runs to prove its check is still wired into CI. */
export function wiredCommand(check: string): string {
  return `node scripts/ci-check-wired.ts '${check}'`;
}
