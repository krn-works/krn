import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const slash = String.fromCharCode(47);
const forbiddenRoots = [
  `${slash}mnt${slash}`,
  `${slash}home${slash}krn`,
  `${slash}run${slash}user${slash}`,
  `${slash}tmp${slash}claude-`,
];
const hostPathAllowlist = new Map([
  [
    'scripts/probe-isolation.mjs',
    'The probe mirrors systemd’s host user runtime default.',
  ],
  [
    'src/hosts/systemd-scope.ts',
    'Systemd scopes derive the conventional user runtime when env omits it.',
  ],
  [
    'src/verdict/sandbox.ts',
    'Sandbox systemd fallback derives the conventional user runtime for D-Bus.',
  ],
]);

function trackedCodePaths() {
  const revision = process.env.KRN_HOST_PATH_GUARD_REVISION;
  const args = revision
    ? [
        'ls-tree',
        '-r',
        '--name-only',
        '-z',
        revision,
        '--',
        'scripts',
        'src',
        'test',
      ]
    : ['ls-files', '-z', '--', 'scripts', 'src', 'test'];
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1)
    if (source[index] === '\n') line += 1;
  return line;
}

function decodeEscapes(value) {
  return value.replace(
    /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/giu,
    (_match, codePoint, unicode, hex, escaped) => {
      if (codePoint !== undefined)
        return String.fromCodePoint(Number.parseInt(codePoint, 16));
      if (unicode !== undefined)
        return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex !== undefined)
        return String.fromCharCode(Number.parseInt(hex, 16));
      if (escaped === undefined || escaped === '\n' || escaped === '\r')
        return '';
      if (escaped === 'n') return '\n';
      if (escaped === 'r') return '\r';
      if (escaped === 't') return '\t';
      if (escaped === 'b') return '\b';
      if (escaped === 'f') return '\f';
      if (escaped === 'v') return '\v';
      return escaped;
    },
  );
}

function forbiddenRootMatches(value) {
  const matches = [];
  for (const root of forbiddenRoots) {
    let offset = value.indexOf(root);
    while (offset !== -1) {
      const next = value[offset + root.length];
      if (
        root !== `${slash}home${slash}krn` ||
        next === undefined ||
        next === slash
      ) {
        const prefix = value.slice(0, offset);
        const previous = value[offset - 1];
        const followsNonFileUrl =
          /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*$/u.test(prefix) &&
          !/file:\/\/[^/]*$/iu.test(prefix);
        const followsScpRemote =
          previous === ':' &&
          /(?:^|[\s=([{,'"`])(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*:$/u.test(
            prefix,
          );
        const followsNameCharacter = /[A-Za-z0-9._~%-]/u.test(previous ?? '');

        if (!followsNameCharacter && !followsNonFileUrl && !followsScpRemote)
          matches.push({ offset, root });
      }
      offset = value.indexOf(root, offset + root.length);
    }
  }
  return matches.sort((left, right) => left.offset - right.offset);
}

function literalPathLines(source) {
  const lines = new Set();
  const record = (raw, offset) => {
    const value = decodeEscapes(raw);
    for (const { offset: valueOffset, root } of forbiddenRootMatches(value)) {
      const rawPath = raw.indexOf(
        value.slice(valueOffset, valueOffset + root.length),
      );
      lines.add(
        lineAt(source, offset + (rawPath === -1 ? valueOffset : rawPath)),
      );
    }
  };

  function scanQuoted(start, quote) {
    let raw = '';
    let index = start + 1;
    while (index < source.length) {
      const character = source[index];
      if (character === quote) {
        record(raw, start + 1);
        return index + 1;
      }
      if (character === '\\') {
        const next = source[index + 1];
        raw += character + (next ?? '');
        index += next === '\r' && source[index + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (character === '\n' || character === '\r') return index + 1;
      raw += character;
      index += 1;
    }
    return index;
  }

  function scanTemplate(start) {
    let raw = '';
    let rawStart = start + 1;
    let index = rawStart;
    while (index < source.length) {
      const character = source[index];
      if (character === '`') {
        record(raw, rawStart);
        return index + 1;
      }
      if (character === '\\') {
        raw += character + (source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (character === '$' && source[index + 1] === '{') {
        record(raw, rawStart);
        raw = '';
        index = scanCode(index + 2, true);
        rawStart = index;
        continue;
      }
      raw += character;
      index += 1;
    }
    record(raw, rawStart);
    return index;
  }

  function scanCode(start, interpolation = false) {
    let index = start;
    let braceDepth = 0;
    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];
      if (character === '/' && next === '/') {
        index += 2;
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        index += 2;
        while (
          index < source.length &&
          !(source[index] === '*' && source[index + 1] === '/')
        )
          index += 1;
        index = Math.min(source.length, index + 2);
        continue;
      }
      if (character === "'" || character === '"') {
        index = scanQuoted(index, character);
        continue;
      }
      if (character === '`') {
        index = scanTemplate(index);
        continue;
      }
      if (interpolation && character === '{') {
        braceDepth += 1;
        index += 1;
        continue;
      }
      if (interpolation && character === '}') {
        if (braceDepth === 0) return index + 1;
        braceDepth -= 1;
        index += 1;
        continue;
      }
      index += 1;
    }
    return index;
  }

  scanCode(0);
  return [...lines].sort((left, right) => left - right);
}

function trackedTextMatches() {
  const matches = [];
  for (const path of trackedCodePaths()) {
    const contents = readFileSync(`${repositoryRoot}/${path}`);
    if (contents.includes(0)) continue;
    const source = contents.toString('utf8');
    for (const line of literalPathLines(source)) matches.push({ path, line });
  }
  return matches;
}

function formatMatches(matches) {
  return matches.map(({ path, line }) => `${path}:${line}`).join('\n');
}

test('tracked test, script, and source literals avoid host-specific paths', () => {
  const matches = trackedTextMatches();
  const unexpected = matches.filter(({ path }) => !hostPathAllowlist.has(path));
  const unusedAllowlist = [...hostPathAllowlist.keys()].filter(
    (path) => !matches.some((match) => match.path === path),
  );

  assert.deepEqual(
    unexpected,
    [],
    `Host-specific absolute paths:\n${formatMatches(unexpected)}`,
  );
  assert.deepEqual(
    unusedAllowlist,
    [],
    'Remove obsolete host-path exceptions.',
  );
  for (const [path, reason] of hostPathAllowlist) {
    assert.ok(reason.trim().length > 0, `${path} needs a one-line reason.`);
    assert.ok(!reason.includes('\n'), `${path} reason must fit on one line.`);
  }
});

function hostPath(...parts) {
  return `${slash}${parts.join(slash)}`;
}

const lit = (value) => JSON.stringify(value);
const scanCases = [
  [
    'flags a path at the start of a string literal',
    lit(hostPath('mnt', 'storage', 'x')),
    [1],
  ],
  [
    'flags a path after whitespace in template text',
    `const command = \`cd ${hostPath('mnt', 'x')}\`;`,
    [1],
  ],
  [
    'flags a path after an assignment separator',
    lit(`PATH=${hostPath('home', 'krn', 'bin')}`),
    [1],
  ],
  [
    'flags a path after a redirect',
    lit(`echo >${hostPath('tmp', 'claude-1', 'log')}`),
    [1],
  ],
  [
    'flags a path after a command separator',
    lit(`a;${hostPath('mnt', 'x')}`),
    [1],
  ],
  ['flags a path after a pipe', lit(`a|${hostPath('home', 'krn', 'x')}`), [1]],
  [
    'flags a path in a command substitution',
    lit(`$(cat ${hostPath('run', 'user', '1', 'x')})`),
    [1],
  ],
  [
    'flags a path in a quoted root option',
    lit(`--root=${hostPath('run', 'user', '1000')}`),
    [1],
  ],
  [
    'flags a path in a file URL with an empty authority',
    lit(`file:${slash}${slash}${hostPath('mnt', 'x')}`),
    [1],
  ],
  [
    'flags a path after whitespace in multiline template text',
    `const command = \`sample\n${hostPath('mnt', 'storage', 'x')}\`;`,
    [2],
  ],
  [
    'ignores a path in a URL authority',
    lit(`https:${slash}${slash}fixture.invalid${hostPath('mnt', 'data')}`),
    [],
  ],
  [
    'ignores an absolute path in an scp-style Git remote',
    lit(`git@host:${hostPath('mnt', 'x')}`),
    [],
  ],
  ['ignores path text after a name character', lit('foo/mnt/x'), []],
  ['ignores path text in a non-file URL path', lit('https://h/mnt/x'), []],
  [
    'ignores the synthetic worker home path',
    lit(hostPath('home', 'worker')),
    [],
  ],
  ['ignores paths in comments', `// ${hostPath('mnt', 'storage', 'x')}`, []],
];

for (const [name, source, lines] of scanCases)
  test(`path scanner ${name}`, () =>
    assert.deepEqual(literalPathLines(source), lines));
