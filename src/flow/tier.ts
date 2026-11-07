// Trusted, pure policy: never load classification rules from the candidate tree.
import { panelRoles, type ReviewRole } from './types.ts';

export type RiskLevel = 'low' | 'medium' | 'high';
export type DiffEntry = {
  path: string;
  added: number | null;
  deleted: number | null;
};

function high(path: string): boolean {
  return (
    /^(?:\.github\/|\.claude\/|\.agents\/|\.codex\/|docs\/adr\/|docs\/program\/|spec\/|src\/(?:flow|deliver|ci|slice|verify)\/|bin\/|scripts\/(?:pr-preflight\.mjs$|head-trailers\.mjs$|gate-local\.mjs$|(?:install|seal)[^/]*$))/.test(
      path,
    ) ||
    /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(path) ||
    ['package.json', 'pnpm-lock.yaml'].includes(path)
  );
}
function low(path: string): boolean {
  return /^(?:test|tasks|docs)\//.test(path) || path.endsWith('.md');
}
function reasonText(text: string): string {
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character) > 200) break;
    result += character;
  }
  return result;
}
export function classifyRiskTier(entries: readonly DiffEntry[]): {
  level: RiskLevel;
  reasons: string[];
} {
  const result = (level: RiskLevel, reason: string) => ({
    level,
    reasons: [reasonText(reason)],
  });
  if (entries.length === 0) return result('medium', 'empty diff');
  if (entries.some(({ path }) => path === ''))
    return result('medium', 'unparsed diff');
  const sensitive = entries.find(({ path }) => high(path));
  if (sensitive) return result('high', `HIGH: ${sensitive.path}`);
  const other = entries.filter(({ path }) => !low(path));
  if (other.length === 0)
    return result('low', `LOW_PATHS: ${entries[0]?.path}`);
  if (
    other.length <= 2 &&
    other.every(({ added, deleted }) => added !== null && deleted !== null) &&
    other.reduce(
      (sum, { added, deleted }) => sum + (added ?? 0) + (deleted ?? 0),
      0,
    ) <= 40
  )
    return result('low', `small diff: ${other[0]?.path}`);
  return result('medium', `default medium: ${other[0]?.path}`);
}
export function tierRoles(level: RiskLevel): readonly ReviewRole[] {
  return level === 'low' ? ['spec'] : panelRoles;
}
