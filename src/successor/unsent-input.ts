// Unsent input: whether a Claude Code prompt box on a screen holds typed text.

const NBSP_PROMPT = '❯';

function isRule(line: string): boolean {
  return line.trim().startsWith('─');
}

/**
 * The prompt box is a `─` rule, a line starting `❯` (followed by a no-break
 * space when empty), more input lines, then a second `─` rule. The last such
 * box on the screen decides; a screen without one has no input to lose.
 */
export function unsentInput(screen: string): boolean {
  const lines = screen.split('\n');
  const rules: number[] = [];
  lines.forEach((line, index) => {
    if (isRule(line)) rules.push(index);
  });
  for (let k = rules.length - 1; k >= 1; k -= 1) {
    const top = rules[k - 1] as number;
    const bottom = rules[k] as number;
    const first = lines[top + 1]?.trimStart();
    if (first === undefined || !first.startsWith(NBSP_PROMPT)) continue;
    const typed = [
      first.slice(NBSP_PROMPT.length),
      ...lines.slice(top + 2, bottom),
    ];
    return typed.join('').trim() !== '';
  }
  return false;
}
