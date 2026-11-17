// Stale statements in agent-facing markdown: skills paths that no longer exist and relay thresholds the gauge no longer advises.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeDir, configHome } from '../harness/claude.ts';
import { advisoriesOf, budget, ceilingOf, defaultWindow } from './gauge.ts';

/** Agent-facing markdown: the instruction files and continuation prompts; history logs record the past and stay as written. */
function agentMarkdown(root: string): string[] {
  const files = ['AGENTS.md', 'CLAUDE.md'].filter((file) =>
    existsSync(join(root, file)),
  );
  const docs = existsSync(join(root, 'docs'))
    ? readdirSync(join(root, 'docs'))
    : [];
  for (const name of docs.sort())
    if (/PROMPT.*\.md$/iu.test(name)) files.push(`docs/${name}`);
  // CLAUDE.md may link to AGENTS.md: one file is read once.
  const seen = new Set<string>();
  return files.filter((file) => {
    const real = realpathSync(join(root, file));
    if (/HIST(?:ORY|ORIA)/iu.test(file) || seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

const skillPath =
  /(?<![\w/.~-])((?:~\/\.claude|\.agents|\.claude)\/skills\/[\w.-]+(?:\/[\w.@-]+)*)/gu;

function skillPathExists(root: string, path: string): boolean {
  const userPrefix = `~/${claudeDir}/`;
  const target = path.startsWith(userPrefix)
    ? join(configHome(), path.slice(userPrefix.length))
    : resolve(root, path);
  return existsSync(target) || existsSync(join(homedir(), path.slice(2)));
}

/** A relay or handoff line quoting a `Nk` figure that is none of the configured window's advisories, ceiling or window. */
const relayFigure =
  /(?:relay|hand ?off|przekaz\w*|hook)\b[^,;.()\n]{0,60}?(?<![\w.])(\d{2,3})\s?k\b/giu;

function configuredWindow(root: string): number {
  try {
    return budget(root);
  } catch {
    return defaultWindow;
  }
}

/**
 * `file:line message` for each stale statement in the agent-facing markdown of a repository: a path under a skills
 * directory that does not exist (a removed skill script) and a relay or handoff context threshold in k tokens that is
 * not one of the gauge advisories, the ceiling or the window of the configured window.
 */
export function staleAgentText(root: string): string[] {
  const window = configuredWindow(root);
  const { first, second } = advisoriesOf(window);
  const allowed = new Set(
    [first, second, ceilingOf(window), window].map((n) => Math.round(n / 1000)),
  );
  const found: string[] = [];
  for (const file of agentMarkdown(root)) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      for (const match of line.matchAll(skillPath)) {
        const path = (match[1] as string).replace(/[.-]+$/u, '');
        if (!skillPathExists(root, path))
          found.push(`${where} names ${path}, which does not exist`);
      }
      for (const match of line.matchAll(relayFigure)) {
        const size = Number(match[1]);
        if (!allowed.has(size))
          found.push(
            `${where} states ${size}k; the gauge advises at ${first / 1000}k and ${second / 1000}k of a ${window / 1000}k window`,
          );
      }
    });
  }
  return found;
}
