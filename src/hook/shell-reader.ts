// The one shell command reader the Bash hooks share (scope, commit-format, unpushed-delete, heavy-command).
// It reads a command line the way POSIX sh and bash split it, without running anything: words with single,
// double, backslash and $'...' quoting removed; the operators `;`, newline, `&&`, `||`, `|`, `|&` and `&`;
// redirections with their descriptor and target word; heredoc bodies as data; `#` comments; and subshell,
// `$(...)`, backtick and process-substitution groups as open/close markers around their own commands.
// `resolveCommand` looks through the wrappers that run another command (`VAR=value`, env with its options,
// command, exec) and says when no command runs at all (`env --help`, `command -v`); `gitCall` reads git's
// global options. Each hook judges words this reader returns instead of splitting text with its own regexes:
// every earlier hook defect was one more quoting or wrapper case a hand-rolled split missed.

/** One shell word: its text after quote removal, with every expansion (`$X`, `$(...)`, backticks) kept verbatim. */
export interface Word {
  readonly text: string;
  /** The shell still expands this word: an unquoted or double-quoted `$` or backtick, or an unquoted leading `~`. */
  readonly expands: boolean;
  /** Some part of the word was quoted or escaped, so it is never a reserved word, descriptor or operator. */
  readonly quoted: boolean;
}

/** One redirection: `2>&1` is fd `2`, op `>&`, target `1`; a heredoc carries its body as data. */
export interface Redirect {
  readonly fd: string;
  readonly op: string;
  readonly target: Word;
  body?: string;
}

/** One simple command; `forked` when it runs in a child shell (a pipeline member or a `&` job). */
export interface Command {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
  readonly forked: boolean;
}

/** The reading of a command line in execution order; `open`/`close` bound a subshell or substitution. */
export type Step =
  | { readonly kind: 'command'; readonly command: Command }
  | { readonly kind: 'open' }
  | { readonly kind: 'close' };

const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
// Words that open or continue compound syntax: the command is the word after them.
const RESERVED = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'time',
]);
const REDIRECT_OPS = [
  '<<<',
  '<<-',
  '&>>',
  '<<',
  '<>',
  '<&',
  '>>',
  '>|',
  '>&',
  '&>',
  '<',
  '>',
];

class Reader {
  readonly steps: Step[] = [];
  private i = 0;
  private readonly pending: Redirect[] = [];

  private readonly s: string;

  constructor(text: string) {
    this.s = text;
  }

  /** Reads commands until the end, or past the `)` that closes a `$(` when `nested`. */
  list(nested = false): void {
    const s = this.s;
    let words: Word[] = [];
    let redirects: Redirect[] = [];
    let piped = false;
    let depth = 0;
    const finish = (forked = false) => {
      while (words[0] && !words[0].quoted && RESERVED.has(words[0].text)) {
        // `time -p` takes its one option with it.
        if (words.shift()?.text === 'time' && words[0]?.text === '-p')
          words.shift();
      }
      if (words.length > 0 || redirects.length > 0)
        this.steps.push({
          kind: 'command',
          command: { words, redirects, forked: forked || piped },
        });
      words = [];
      redirects = [];
      piped = false;
    };
    while (this.i < s.length) {
      const c = s[this.i] as string;
      const next = s[this.i + 1];
      if (c === '\\' && next === '\n') this.i += 2;
      else if (c === ' ' || c === '\t') this.i++;
      else if (c === '\n') {
        this.i++;
        finish();
        this.heredocs();
      } else if (c === '#') {
        const eol = s.indexOf('\n', this.i);
        this.i = eol < 0 ? s.length : eol;
      } else if (c === ')') {
        finish();
        this.i++;
        if (depth === 0 && nested) return;
        depth = Math.max(0, depth - 1);
        this.steps.push({ kind: 'close' });
      } else if (c === '(') {
        finish();
        this.i++;
        depth++;
        this.steps.push({ kind: 'open' });
      } else if (c === ';') {
        finish();
        this.i++;
      } else if (c === '&' && next === '&') {
        finish();
        this.i += 2;
      } else if (c === '&' && next === '>') {
        redirects.push(this.redirect(''));
      } else if (c === '&') {
        finish(true);
        this.i++;
      } else if (c === '|' && next === '|') {
        finish();
        this.i += 2;
      } else if (c === '|') {
        finish(true);
        piped = true;
        this.i += next === '&' ? 2 : 1;
      } else if ((c === '<' || c === '>') && next !== '(') {
        redirects.push(this.redirect(''));
      } else {
        const word = this.word();
        const after = s[this.i];
        if (
          /^\d+$/u.test(word.text) &&
          !word.quoted &&
          (after === '<' || after === '>') &&
          s[this.i + 1] !== '('
        )
          redirects.push(this.redirect(word.text));
        else words.push(word);
      }
    }
    finish();
  }

  private redirect(fd: string): Redirect {
    const op = REDIRECT_OPS.find((candidate) =>
      this.s.startsWith(candidate, this.i),
    ) as string;
    this.i += op.length;
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
    const found: Redirect = { fd, op, target: this.word() };
    if (op === '<<' || op === '<<-') this.pending.push(found);
    return found;
  }

  /** Heredoc bodies start on the line after their operator; each line is data up to its delimiter. */
  private heredocs(): void {
    const s = this.s;
    for (const doc of this.pending.splice(0)) {
      const delimiter = doc.target.text;
      const lines: string[] = [];
      while (this.i < s.length) {
        const eol = s.indexOf('\n', this.i);
        const end = eol < 0 ? s.length : eol;
        const line = s.slice(this.i, end);
        // Bash ends the body only at a line that is exactly the delimiter; `<<-` strips leading tabs.
        const bare = doc.op === '<<-' ? line.replace(/^\t+/u, '') : line;
        if (bare === delimiter) {
          this.i = eol < 0 ? s.length : eol + 1;
          break;
        }
        lines.push(line);
        this.i = eol < 0 ? s.length : eol + 1;
      }
      doc.body = lines.join('\n');
    }
  }

  private word(): Word {
    const s = this.s;
    const start = this.i;
    let text = '';
    let expands = false;
    let quoted = false;
    if ((s[start] === '<' || s[start] === '>') && s[start + 1] === '(') {
      this.i += 2;
      this.group();
      return { text: s.slice(start, this.i), expands: true, quoted: false };
    }
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (META.has(c)) break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') this.i += 2;
        else {
          text += s[this.i + 1] ?? '\\';
          quoted = true;
          this.i += 2;
        }
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        const stop = end < 0 ? s.length : end;
        text += s.slice(this.i + 1, stop);
        quoted = true;
        this.i = stop + 1;
      } else if (c === '"') {
        quoted = true;
        this.i++;
        while (this.i < s.length && s[this.i] !== '"') {
          const d = s[this.i] as string;
          const e = s[this.i + 1] ?? '';
          if (d === '\\' && e === '\n') this.i += 2;
          else if (d === '\\' && '$`"\\'.includes(e) && e !== '') {
            text += e;
            this.i += 2;
          } else if (d === '$' || d === '`') {
            const part = this.expansion();
            text += part.text;
            expands ||= part.expands;
          } else {
            text += d;
            this.i++;
          }
        }
        this.i++;
      } else if (c === '$' && s[this.i + 1] === "'") {
        text += this.ansiC();
        quoted = true;
      } else if (c === '$' || c === '`') {
        const part = this.expansion();
        text += part.text;
        expands ||= part.expands;
      } else {
        if (c === '~' && text === '' && !quoted) expands = true;
        text += c;
        this.i++;
      }
    }
    return { text, expands, quoted };
  }

  /** `$'...'`: backslash escapes are decoded, the rest is literal. */
  private ansiC(): string {
    const s = this.s;
    const escapes: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      a: '\u0007',
      b: '\b',
      e: '\u001b',
      f: '\f',
      v: '\v',
    };
    let text = '';
    this.i += 2;
    while (this.i < s.length && s[this.i] !== "'") {
      const c = s[this.i] as string;
      if (c === '\\' && this.i + 1 < s.length) {
        const e = s[this.i + 1] as string;
        // \xHH, \uHHHH, \UHHHHHHHH and \NNN (octal) name a character by its code.
        const code =
          /^x([0-9a-fA-F]{1,2})|^u([0-9a-fA-F]{1,4})|^U([0-9a-fA-F]{1,8})|^([0-7]{1,3})/u.exec(
            s.slice(this.i + 1),
          );
        if (code) {
          const hex = code[1] ?? code[2] ?? code[3];
          const point =
            hex === undefined
              ? Number.parseInt(code[4] as string, 8)
              : Number.parseInt(hex, 16);
          text += String.fromCodePoint(Math.min(point, 0x10ffff));
          this.i += 1 + code[0].length;
          continue;
        }
        text += escapes[e] ?? e;
        this.i += 2;
      } else {
        text += c;
        this.i++;
      }
    }
    this.i++;
    return text;
  }

  /** A `$` or backtick expansion at the cursor, kept verbatim; `$(cat <<EOF ... EOF)` yields its heredoc text. */
  private expansion(): { text: string; expands: boolean } {
    const s = this.s;
    const start = this.i;
    const raw = () => ({ text: s.slice(start, this.i), expands: true });
    if (s[start] === '`') {
      let end = start + 1;
      let inner = '';
      while (end < s.length && s[end] !== '`') {
        if (s[end] === '\\' && '`$\\'.includes(s[end + 1] ?? '')) end++;
        inner += s[end];
        end++;
      }
      const sub = new Reader(inner);
      sub.list();
      this.steps.push({ kind: 'open' }, ...sub.steps, { kind: 'close' });
      this.i = Math.min(end + 1, s.length);
      return raw();
    }
    const next = s[start + 1] ?? '';
    if (next === '(' && s[start + 2] === '(') {
      this.i = closing(s, start + 1, '(', ')');
      return raw();
    }
    if (next === '(') {
      this.i += 2;
      const from = this.steps.length;
      this.group();
      const message = heredocMessage(this.steps.slice(from + 1, -1));
      if (message !== undefined) return { text: message, expands: false };
      return raw();
    }
    if (next === '{') {
      this.i = closing(s, start + 1, '{', '}');
      return raw();
    }
    if (/[A-Za-z_]/u.test(next)) {
      this.i++;
      while (/[A-Za-z0-9_]/u.test(s[this.i] ?? '')) this.i++;
      return raw();
    }
    if (/[0-9@*#?$!-]/u.test(next)) {
      this.i += 2;
      return raw();
    }
    this.i++;
    return { text: '$', expands: false };
  }

  /** The commands of a `$(`, `<(` or `>(` group (cursor past its `(`), bounded by open and close. */
  private group(): void {
    this.steps.push({ kind: 'open' });
    this.list(true);
    this.steps.push({ kind: 'close' });
  }
}

/** The index past the `close` that matches the `open` at `at`. */
function closing(s: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i + 1;
  }
  return s.length;
}

/** The text of a `$(cat <<EOF ... EOF)` substitution: the heredoc body without trailing newlines. */
function heredocMessage(inner: readonly Step[]): string | undefined {
  const [only, ...rest] = inner;
  if (only?.kind !== 'command' || rest.length > 0) return undefined;
  const { words, redirects } = only.command;
  const [doc, ...more] = redirects;
  if (words.length !== 1 || words[0]?.text !== 'cat' || more.length > 0)
    return undefined;
  // Only a heredoc on standard input is what cat prints.
  if (doc !== undefined && doc.fd !== '' && doc.fd !== '0') return undefined;
  if (doc?.body === undefined) return undefined;
  return doc.body.replace(/\n+$/u, '');
}

/** The steps of `text` in execution order. */
export function readShell(text: string): Step[] {
  const reader = new Reader(text);
  reader.list();
  return reader.steps;
}

/** Every simple command of `text`, subshells and substitutions included. */
export function commandsOf(text: string): Command[] {
  return readShell(text).flatMap((step) =>
    step.kind === 'command' ? [step.command] : [],
  );
}

/** Every simple command of `text` as its word texts. */
export function commands(text: string): string[][] {
  return commandsOf(text)
    .map((command) => command.words.map((word) => word.text))
    .filter((words) => words.length > 0);
}

/** The program a word names (`/usr/bin/git` is `git`); an expanding word names none. */
export function programName(word: Word | undefined): string {
  if (word === undefined || word.expands) return '';
  return word.text.slice(word.text.lastIndexOf('/') + 1);
}

/** A command after its wrappers: `argv[0]` is the program that runs, `chdirs` the `env -C` directories in order. */
export interface Resolved {
  readonly argv: readonly Word[];
  readonly chdirs: readonly Word[];
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

type OptionKind = 'flag' | 'arg' | 'optional' | 'none' | 'split';
// GNU env 9 (`env --help`): `none` means no command runs (help, version); `split` (-S) splits its value
// into the words that follow, as env does.
const ENV_LONG: Record<string, OptionKind> = {
  argv0: 'arg',
  'ignore-environment': 'flag',
  'env0-from': 'arg',
  null: 'flag',
  unset: 'arg',
  chdir: 'arg',
  'split-string': 'split',
  'block-signal': 'optional',
  'default-signal': 'optional',
  'ignore-signal': 'optional',
  'list-signal-handling': 'flag',
  debug: 'flag',
  help: 'none',
  version: 'none',
};
const ENV_SHORT: Record<string, OptionKind> = {
  a: 'arg',
  i: 'flag',
  '0': 'flag',
  u: 'arg',
  C: 'arg',
  S: 'split',
  v: 'flag',
};
// bash `help command` and `help exec`: `command -v`/`-V` only describe the command.
const COMMAND_SHORT: Record<string, OptionKind> = {
  p: 'flag',
  v: 'none',
  V: 'none',
};
const EXEC_SHORT: Record<string, OptionKind> = {
  c: 'flag',
  l: 'flag',
  a: 'arg',
};

/**
 * Reads the options of a wrapper from `argv[1]` as getopt does (short clusters, `-uNAME`, `--unset=NAME`,
 * unique long prefixes, `--`). Returns the index of its first operand and each `C`/`chdir` value, or
 * undefined when no command runs: an unknown option, a `none` option, or a missing option argument.
 */
function options(
  argv: readonly Word[],
  short: Record<string, OptionKind>,
  long: Record<string, OptionKind> = {},
): { at: number; chdirs: Word[]; split?: Word[] } | undefined {
  const chdirs: Word[] = [];
  let i = 1;
  while (i < argv.length) {
    const word = argv[i] as Word;
    const text = word.text;
    if (text === '--') return { at: i + 1, chdirs };
    if (!text.startsWith('-') || text === '-') return { at: i, chdirs };
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = text.slice(2, eq < 0 ? undefined : eq);
      const matches = Object.keys(long).filter((key) => key.startsWith(name));
      const key = name in long ? name : matches.length === 1 ? matches[0] : '';
      const kind = key ? long[key] : undefined;
      if (kind === undefined || kind === 'none') return undefined;
      if (kind === 'flag' && eq >= 0) return undefined;
      let value: Word | undefined;
      if (kind === 'arg' || kind === 'split') {
        if (eq < 0) i++;
        value = eq >= 0 ? { ...word, text: text.slice(eq + 1) } : argv[i];
        if (value === undefined) return undefined;
      }
      if (key === 'chdir' && value) chdirs.push(value);
      if (kind === 'split') return splitString(argv, i, value as Word, chdirs);
      i++;
      continue;
    }
    for (let j = 1; j < text.length; j++) {
      const letter = text[j] as string;
      const kind = short[letter];
      if (kind === undefined || kind === 'none' || kind === 'optional')
        return undefined;
      if (kind === 'arg' || kind === 'split') {
        if (j + 1 === text.length) i++;
        const value =
          j + 1 < text.length ? { ...word, text: text.slice(j + 1) } : argv[i];
        if (value === undefined) return undefined;
        if (letter === 'C') chdirs.push(value);
        if (kind === 'split') return splitString(argv, i, value, chdirs);
        break;
      }
    }
    i++;
  }
  return { at: i, chdirs };
}

/**
 * `env -S STRING` puts the words of STRING in its own place and reads options again: the result is
 * `split` with argv[0] still env. A STRING the shell still expands names no command the hook can see.
 */
function splitString(
  argv: readonly Word[],
  at: number,
  value: Word,
  chdirs: Word[],
): { at: number; chdirs: Word[]; split: Word[] } | undefined {
  if (value.expands) return undefined;
  const words = commandsOf(value.text)[0]?.words ?? [];
  if (words.some((word) => word.expands)) return undefined;
  return {
    at: 0,
    chdirs,
    split: [argv[0] as Word, ...words, ...argv.slice(at + 1)],
  };
}

/**
 * The command that runs after `VAR=value` prefixes and the env, command and exec wrappers, looped until
 * none is left; undefined when no command runs (an option that only prints, a wrapper with no command)
 * or the hook cannot see it (an `env -S` string the shell still expands).
 */
export function resolveCommand(words: readonly Word[]): Resolved | undefined {
  let argv = words;
  const chdirs: Word[] = [];
  for (;;) {
    let at = 0;
    while (at < argv.length && ASSIGNMENT.test(argv[at]?.text ?? '')) at++;
    argv = argv.slice(at);
    const name = programName(argv[0]);
    const read =
      name === 'env'
        ? options(argv, ENV_SHORT, ENV_LONG)
        : name === 'command' && !argv[0]?.quoted
          ? options(argv, COMMAND_SHORT)
          : name === 'exec' && !argv[0]?.quoted
            ? options(argv, EXEC_SHORT)
            : { at: 0, chdirs: [] };
    if (read === undefined) return undefined;
    if (read.split) {
      chdirs.push(...read.chdirs);
      argv = read.split;
      continue;
    }
    if (read.at === 0) return argv.length > 0 ? { argv, chdirs } : undefined;
    chdirs.push(...read.chdirs);
    // A lone `-` after env's options means -i.
    const lone = name === 'env' && argv[read.at]?.text === '-' ? 1 : 0;
    argv = argv.slice(read.at + lone);
  }
}

// git's global options that take the next word as their value.
const GIT_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
]);

/**
 * A git call: its `-C` directories in order, the repository-selecting options (`-C`, `--git-dir`,
 * `--work-tree`, each as `[flag, value]` words), subcommand and arguments; undefined when no subcommand runs.
 */
export function gitCall(argv: readonly Word[]):
  | {
      dirs: Word[];
      repository: string[];
      verb: string;
      args: readonly Word[];
    }
  | undefined {
  if (programName(argv[0]) !== 'git') return undefined;
  const dirs: Word[] = [];
  const repository: string[] = [];
  let i = 1;
  while (i < argv.length && (argv[i]?.text ?? '').startsWith('-')) {
    const text = argv[i]?.text ?? '';
    if (['-h', '--help', '-v', '--version'].includes(text)) return undefined;
    const value = argv[i + 1];
    if (text === '-C' && value) dirs.push(value);
    if (['-C', '--git-dir', '--work-tree'].includes(text) && value)
      repository.push(text, value.text);
    else if (/^--(?:git-dir|work-tree)=/u.test(text)) repository.push(text);
    i += GIT_VALUE.has(text) ? 2 : 1;
  }
  const verb = argv[i];
  if (verb === undefined) return undefined;
  return { dirs, repository, verb: verb.text, args: argv.slice(i + 1) };
}
