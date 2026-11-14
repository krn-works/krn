/** One word, single-quoted so `sh -c` and a reader both see exactly this text. */
export function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The words as one shell command line, each word quoted. */
export function shellWords(words: readonly string[]): string {
  return words.map(shellWord).join(' ');
}
