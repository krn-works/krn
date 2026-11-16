// `krn doctor --unattended` skill check: Claude Code prompts before an unattended run (scheduled task or
// /loop) uses a skill that declares allowed-tools or hooks, unless `Skill(<name>)` is in permissions.allow.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir } from '../harness/claude.ts';

const skillRoots = [join(claudeDir, 'skills'), join('.agents', 'skills')];

/** Top-level keys of the leading `---` frontmatter block of a SKILL.md, with their inline values. */
export function frontmatterKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return keys;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (match?.[1] !== undefined) keys.set(match[1], match[2] ?? '');
  }
  return keys;
}

/** Names of repository skills that declare allowed-tools or hooks. */
export function guardedSkillNames(root: string): string[] {
  const names = new Set<string>();
  for (const skillRoot of skillRoots) {
    const base = join(root, skillRoot);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const keys = frontmatterKeys(readFileSync(file, 'utf8'));
      if (keys.has('allowed-tools') || keys.has('hooks'))
        names.add(keys.get('name')?.trim() || entry.name);
    }
  }
  return [...names].sort();
}

function allowEntries(root: string): string[] {
  const file = join(root, claudeDir, 'settings.json');
  if (!existsSync(file)) return [];
  const allow = (
    JSON.parse(readFileSync(file, 'utf8')) as {
      permissions?: { allow?: unknown };
    }
  ).permissions?.allow;
  return Array.isArray(allow)
    ? allow.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Skills that declare allowed-tools or hooks and have no `Skill(<name>)` allow entry. */
export function skillsMissingPermission(root: string): string[] {
  const allowed = new Set(allowEntries(root));
  return guardedSkillNames(root).filter(
    (name) => !allowed.has(`Skill(${name})`),
  );
}
