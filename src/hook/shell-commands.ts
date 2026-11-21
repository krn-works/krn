// Shell words and commands of a Bash command line, for the heavy-command hook.
type Token = { word: string } | { separator: true };

/** A `"$(cat <<'EOF' ... EOF)"` word: the heredoc text, else undefined. */
function heredocText(word: string): string | undefined {
  const match =
    /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*\n?\s*\)\s*$/u.exec(
      word,
    );
  return match?.[3];
}

/** Shell words and command separators of `command`; quotes are removed, `$(...)` inside double quotes is kept verbatim. */
export function shellTokens(command: string): Token[] {
  const tokens: Token[] = [];
  let word: string | undefined;
  let dynamic = false;
  const push = () => {
    if (word !== undefined)
      tokens.push({ word: dynamic ? `\u0000${word}` : word });
    word = undefined;
    dynamic = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? '';
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word = (word ?? '') + command.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      let text = '';
      i++;
      while (i < command.length && command[i] !== '"') {
        const d = command[i] ?? '';
        if (d === '\\' && i + 1 < command.length) {
          text += command[i + 1];
          i += 2;
        } else if (d === '$' && command[i + 1] === '(') {
          const heredoc = /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n/u.exec(
            command.slice(i),
          );
          let end: number;
          if (heredoc) {
            const close = new RegExp(
              `\\n\\s*${heredoc[2]}\\s*\\n?\\s*\\)`,
              'u',
            );
            const found = close.exec(command.slice(i + heredoc[0].length - 1));
            end = found
              ? i + heredoc[0].length - 1 + found.index + found[0].length
              : command.length;
          } else {
            let depth = 0;
            end = i + 1;
            for (; end < command.length; end++) {
              if (command[end] === '(') depth++;
              else if (command[end] === ')' && --depth === 0) break;
            }
            end++;
          }
          const inner = command.slice(i, end);
          const text2 = heredocText(inner);
          if (text2 === undefined) dynamic = true;
          text += text2 ?? inner;
          i = end;
        } else {
          if (d === '$' || d === '`') dynamic = true;
          text += d;
          i++;
        }
      }
      word = (word ?? '') + text;
    } else if (c === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[i + 1];
      i++;
    } else if (/[\s]/u.test(c)) {
      push();
      if (c === '\n') tokens.push({ separator: true });
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      push();
      tokens.push({ separator: true });
    } else {
      if (c === '$' || c === '`') dynamic = true;
      word = (word ?? '') + c;
    }
  }
  push();
  return tokens;
}

/** The commands of `command`: each a list of words, separators dropped. */
export function commands(command: string): string[][] {
  const out: string[][] = [[]];
  for (const token of shellTokens(command)) {
    if ('separator' in token) out.push([]);
    else out[out.length - 1]?.push(token.word);
  }
  return out.filter((words) => words.length > 0);
}
