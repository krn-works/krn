/** One word, single-quoted so `sh -c` and a reader both see exactly this text. */
export function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The words as one shell command line, each word quoted. */
export function shellWords(words: readonly string[]): string {
  return words.map(shellWord).join(' ');
}

// Quoted text and heredoc bodies are data, not commands: an `echo` of the kill pattern into a
// notes file must run. Drops single-quoted spans, double-quoted spans with no command
// substitution, and heredoc bodies; a double-quoted span holding `$(` or a backtick stays,
// because it can execute.
export function executableText(command: string): string {
  let out = '';
  const pending: { word: string; strip: boolean }[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      i = end < 0 ? command.length : end + 1;
      out += "''";
    } else if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"')
        j += command[j] === '\\' ? 2 : 1;
      const span = command.slice(i, j + 1);
      out += /\$\(|`/u.test(span) ? span : '""';
      i = j + 1;
    } else if (ch === '\\') {
      out += command.slice(i, i + 2);
      i += 2;
    } else if (ch === '\n' && pending.length > 0) {
      out += '\n';
      i += 1;
      for (const { word, strip } of pending.splice(0)) {
        while (i < command.length) {
          const eol = command.indexOf('\n', i);
          const line = command.slice(i, eol < 0 ? command.length : eol);
          i = eol < 0 ? command.length : eol + 1;
          if ((strip ? line.trim() : line) === word) break;
        }
      }
    } else {
      const heredoc = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?(\w+))/u.exec(
        command.slice(i),
      );
      if (heredoc && command[i + 2] !== '<') {
        pending.push({
          word: (heredoc[2] ?? heredoc[3] ?? heredoc[4]) as string,
          strip: heredoc[1] === '-',
        });
        out += heredoc[0];
        i += heredoc[0].length;
      } else {
        out += ch;
        i += 1;
      }
    }
  }
  return out;
}
