export const stages = [
  'base',
  'worktree',
  'claim',
  'brief',
  'worker',
  'commit',
  'verify',
  'pr',
  'review',
  'gate',
  'deliver',
  'done',
] as const;
export type Stage = (typeof stages)[number];

export function oneLine(text: string): string {
  return (text.split(/[\n\r\u2028\u2029]/u)[0] ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .slice(0, 200);
}

// brief check emits bare option names and POSIX single-quoted values.
export function parseArgv(output: string): string[] {
  const lines = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('argv: '));
  if (lines.length !== 1) throw new Error('expected one argv: line');
  const text = lines[0]?.slice(6) ?? '';
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ') {
      i++;
      continue;
    }
    let word = '';
    if (text.startsWith('--', i)) {
      const match = /^--(?:allow|require|observer)(?= |$)/u.exec(text.slice(i));
      if (!match) throw new Error('invalid argv option');
      word = match[0];
      i += word.length;
    } else {
      if (text[i] !== "'") throw new Error('argv values must be single quoted');
      while (text[i] === "'") {
        i++;
        const end = text.indexOf("'", i);
        if (end < 0) throw new Error('unterminated argv quote');
        const part = text.slice(i, end);
        if (/["$\\]/u.test(part)) throw new Error('invalid argv quoted text');
        word += part;
        i = end + 1;
        if (text.startsWith("\\''", i)) {
          word += "'";
          i += 2;
        } else break;
      }
    }
    if (i < text.length && text[i] !== ' ')
      throw new Error('invalid argv grammar');
    words.push(word);
    if (words.length > 64) throw new Error('argv exceeds 64 words');
  }
  if (!words.length || words.length % 2) throw new Error('invalid argv pairs');
  for (let j = 0; j < words.length; j += 2) {
    if (
      !['--allow', '--require', '--observer'].includes(words[j] ?? '') ||
      !words[j + 1] ||
      /[\p{Cc}\p{Cf}]/u.test(words[j + 1] ?? '')
    )
      throw new Error('invalid argv pair');
  }
  if (!words.includes('--observer')) throw new Error('argv missing observer');
  return words;
}

export function implementationMessage(
  body: string,
  task: string,
  observers: string[],
): string {
  return `${body.trimEnd()}\n\nTicket: ${task}\n${observers.map((path) => `Change-contract: ${path}:red->green`).join('\n')}\n`;
}
