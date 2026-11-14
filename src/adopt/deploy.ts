// Deploy workflows on the base branch.

// A workflow that runs on a push to the base branch and deploys ships to production when auto-merge
// lands a PR. Workflows are read as text; the shapes below are the ones GitHub accepts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = '.github/workflows';

/** Known deploy and publish actions (the `uses:` owner/name). */
const deployActions =
  /^(cloudflare\/(wrangler|pages)-action|amondnet\/vercel-action|peaceiris\/actions-gh-pages|jamesives\/github-pages-deploy-action|actions\/deploy-pages|appleboy\/(ssh|scp)-action|burnett01\/rsync-deployments|easingthemes\/ssh-deploy|azure\/(webapps-deploy|functions-action|static-web-apps-deploy)|superfly\/flyctl-actions|pypa\/gh-action-pypi-publish|softprops\/action-gh-release|js-devtools\/npm-publish|google-github-actions\/deploy-\w+|aws-actions\/amazon-ecs-deploy-task-definition|sshpass|netlify\/actions|jsmrcaga\/action-netlify-deploy)\b/iu;
/** Deploy tools a step may run. */
const deployCommands =
  /\b(ssh|scp|rsync|wrangler|vercel|plesk|flyctl|netlify deploy|npm publish|pnpm publish|kubectl apply|helm upgrade|cargo publish|twine upload)\b/iu;
const deployStepName = /\b(deploy\w*|publish\w*|release)\b/iu;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function clean(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|\s)#.*$/u, '').trimEnd())
    .filter((line) => line.trim() !== '');
}

/** Lines of the block under the top-level key at `at`, and the index after it. */
function blockAt(lines: string[], at: number): [string[], number] {
  const base = indentOf(lines[at] ?? '');
  let end = at + 1;
  while (end < lines.length && indentOf(lines[end] ?? '') > base) end++;
  return [lines.slice(at + 1, end), end];
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/gu, '');
}

function listOf(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/gu, '')
    .split(',')
    .map(unquote)
    .filter((v) => v !== '');
}

function globMatches(pattern: string, name: string): boolean {
  const source = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${source}$`, 'u').test(name);
}

/** Values of `key:` inside an event block: inline `[a, b]`, a scalar, or a `- item` list. */
function filterValues(block: string[], key: string): string[] | undefined {
  const at = block.findIndex((l) =>
    new RegExp(`^\\s*${key}\\s*:`, 'u').test(l),
  );
  if (at < 0) return undefined;
  const inline = (block[at] ?? '').replace(/^[^:]*:/u, '').trim();
  if (inline !== '') return listOf(inline);
  return blockAt(block, at)[0]
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => unquote(l.slice(1)));
}

/** Whether an event block (the lines under `push:` or `workflow_run:`) can fire for `base`. */
function reachesBase(block: string[], base: string, event: string): boolean {
  const branches = filterValues(block, 'branches');
  const ignored = filterValues(block, 'branches-ignore');
  if (branches !== undefined) return branches.some((p) => globMatches(p, base));
  if (ignored !== undefined) return !ignored.some((p) => globMatches(p, base));
  // A push filtered by tags alone never fires for a branch.
  if (event === 'push' && filterValues(block, 'tags') !== undefined)
    return false;
  return true;
}

/** Splits a flow-map body at commas outside brackets and braces. */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

const unbrace = (value: string) => value.replace(/^\{|\}$/gu, '');

/** The `on:` section as its event names, each with its filter lines. */
function triggers(lines: string[]): Map<string, string[]> {
  const at = lines.findIndex((l) => /^["']?on["']?\s*:/u.test(l));
  const events = new Map<string, string[]>();
  if (at < 0) return events;
  const inline = (lines[at] ?? '').replace(/^[^:]*:/u, '').trim();
  const [block] = blockAt(lines, at);
  if (inline.startsWith('{')) {
    for (const part of splitFlow(unbrace(inline))) {
      const colon = part.indexOf(':');
      const name = unquote(colon < 0 ? part : part.slice(0, colon));
      const rest = colon < 0 ? '' : part.slice(colon + 1).trim();
      events.set(name, rest.startsWith('{') ? splitFlow(unbrace(rest)) : []);
    }
  } else if (inline !== '') {
    for (const name of listOf(inline)) events.set(name, []);
  } else {
    const step = indentOf(block[0] ?? '');
    for (const [i, line] of block.entries()) {
      if (indentOf(line) !== step) continue;
      const item = line.trim();
      if (item.startsWith('-')) {
        events.set(unquote(item.slice(1)), []);
        continue;
      }
      const colon = item.indexOf(':');
      const rest = item.slice(colon + 1).trim();
      events.set(
        unquote(item.slice(0, colon)),
        rest.startsWith('{') ? splitFlow(unbrace(rest)) : blockAt(block, i)[0],
      );
    }
  }
  return events;
}

/** Whether the workflow text runs on a push to `base`, or after a workflow run that does. */
export function runsOnBase(text: string, base: string): boolean {
  for (const [event, block] of triggers(clean(text)))
    if (
      (event === 'push' || event === 'workflow_run') &&
      reachesBase(block, base, event)
    )
      return true;
  return false;
}

/** Whether a step or job of the workflow text deploys. */
export function deploys(text: string): boolean {
  const lines = clean(text);
  const at = lines.findIndex((l) => /^["']?on["']?\s*:/u.test(l));
  const body =
    at < 0
      ? lines
      : [...lines.slice(0, at), ...lines.slice(blockAt(lines, at)[1])];
  return body.some((line) => {
    const trimmed = line.trim().replace(/^-\s*/u, '');
    if (/^environment\s*:/u.test(trimmed)) return true;
    const uses = /^uses\s*:\s*["']?([^@"'\s]+)/u.exec(trimmed);
    if (uses) return deployActions.test(uses[1] ?? '');
    if (/^name\s*:/u.test(trimmed)) return deployStepName.test(trimmed);
    if (
      /^(on|jobs|steps|env|with|runs-on|needs|if|permissions)\s*:/u.test(
        trimmed,
      )
    )
      return false;
    return deployCommands.test(trimmed);
  });
}

/** Workflow files of `root` that deploy on a push to `base`, by file name. */
export function deployWorkflows(root: string, base: string): string[] {
  const dir = join(root, WORKFLOWS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/u.test(f))
    .sort()
    .filter((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      return runsOnBase(text, base) && deploys(text);
    })
    .map((f) => `${WORKFLOWS}/${f}`);
}

/** The remedy text both `krn adopt --verify` and `krn pr ship` print. */
export function deployRemedy(files: string[], base: string): string {
  return `${files.join(', ')} ${files.length === 1 ? 'deploys' : 'deploy'} on a push to ${base}, so auto-merge ships to production unattended; review it and set "deploy": "acknowledged" in krn.json to accept auto-merge there`;
}
