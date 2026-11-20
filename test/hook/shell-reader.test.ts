import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { decide as commitFormat } from '../../src/hook/commit-format.ts';
import { decide as scope } from '../../src/hook/scope.ts';
import {
  commands,
  commandsOf,
  gitCall,
  readShell,
  resolveCommand,
} from '../../src/hook/shell-reader.ts';
import { targets } from '../../src/hook/unpushed-delete.ts';

// The words real bash gives one simple command with no expansion in it: the oracle for quoting rows.
function bashWords(command: string): string[] {
  const run = spawnSync(
    'bash',
    ['-c', `words() { printf '%s\\0' "$@"; }; words ${command}`],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.split('\0').slice(0, -1);
}

test('quoting rows split into the words bash gives them', () => {
  for (const line of [
    String.raw`cp tasks/input\(old\) src/output`,
    "cp 'tasks/draft(old).txt' src/copy.txt",
    `cd '/base/lane(1)'`,
    String.raw`echo "a \"b\" \$c \\ d" 'e "f"' g\ h`,
    "echo $'tab\\there' it\\'s",
    'echo "x > y" \'a | b; c && d\'',
    'echo a\\\nb c',
    'echo "multi\nline" "(paren)" \'$(not run)\'',
    'echo ""  \'\' x',
  ])
    assert.deepEqual(commands(line)[0], bashWords(line), line);
});

test('operators, groups and substitutions bound the commands', () => {
  const rows: [string, string[][]][] = [
    ['a; b && c || d | e & f', [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]],
    ['a\nb', [['a'], ['b']]],
    ['(cd x && y) ; z', [['cd', 'x'], ['y'], ['z']]],
    [
      'echo $(rm x) `rm y`',
      [
        ['rm', 'x'],
        ['rm', 'y'],
        ['echo', '$(rm x)', '`rm y`'],
      ],
    ],
    [
      'echo "$(rm x)"',
      [
        ['rm', 'x'],
        ['echo', '$(rm x)'],
      ],
    ],
    [
      'diff <(ls a) b',
      [
        ['ls', 'a'],
        ['diff', '<(ls a)', 'b'],
      ],
    ],
    ['echo a # rm tasks/x', [['echo', 'a']]],
    ['if true; then rm x; fi', [['true'], ['rm', 'x']]],
    [
      '{ cd x; rm y; }',
      [
        ['cd', 'x'],
        ['rm', 'y'],
      ],
    ],
    ["cat <<'EOF' > out\nrm src/x\nEOF\nls", [['cat'], ['ls']]],
    ['echo $((1+2))', [['echo', '$((1+2))']]],
  ];
  for (const [line, expected] of rows)
    assert.deepEqual(commands(line), expected, line);
});

test('redirections carry their descriptor, operator and target', () => {
  const [command] = commandsOf('npm test 2>&1 >> "a b.log" &> c <<< d');
  assert.deepEqual(
    command?.redirects.map((r) => [r.fd, r.op, r.target.text]),
    [
      ['2', '>&', '1'],
      ['', '>>', 'a b.log'],
      ['', '&>', 'c'],
      ['', '<<<', 'd'],
    ],
  );
  assert.deepEqual(
    command?.words.map((w) => w.text),
    ['npm', 'test'],
  );
  const [quoted] = commandsOf("echo '>' x \\> y");
  assert.equal(quoted?.redirects.length, 0);
  assert.deepEqual(
    quoted?.words.map((w) => w.text),
    ['echo', '>', 'x', '>', 'y'],
  );
});

test('a heredoc body is data, and $(cat <<EOF) yields its text', () => {
  const [cat] = commandsOf("cat <<-'EOF'\n\trm x\n\tEOF\n");
  assert.equal(cat?.redirects[0]?.body, '\trm x');
  const [commit] = commandsOf(
    `git commit -m "$(cat <<'EOF'\nfix(a): b\n\nBody (with parens.\nEOF\n)"`,
  ).slice(-1);
  const message = commit?.words.at(-1);
  assert.equal(message?.text, 'fix(a): b\n\nBody (with parens.');
  assert.equal(message?.expands, false);
});

test('a word that expands is marked, a quoted one is not', () => {
  const words = commandsOf("echo $X \"$Y\" '$Z' ~/a '~/b' ${W}/c `id` a~b")[1]
    ?.words;
  assert.deepEqual(
    words?.map((w) => [w.text, w.expands]),
    [
      ['echo', false],
      ['$X', true],
      ['$Y', true],
      ['$Z', false],
      ['~/a', true],
      ['~/b', false],
      ['${W}/c', true],
      ['`id`', true],
      ['a~b', false],
    ],
  );
});

test('subshell and substitution steps open and close around their commands', () => {
  assert.deepEqual(
    readShell('(cd x) && echo $(pwd)').map((step) => step.kind),
    ['open', 'command', 'close', 'open', 'command', 'close', 'command'],
  );
  const [first, second] = commandsOf('cd x | cat');
  assert.equal(first?.forked, true);
  assert.equal(second?.forked, true);
  assert.equal(commandsOf('cd x && y')[0]?.forked, false);
});

test('wrappers resolve to the command that runs, or to none', () => {
  const run = (line: string) => {
    const resolved = resolveCommand(commandsOf(line)[0]?.words ?? []);
    return (
      resolved && {
        argv: resolved.argv.map((w) => w.text),
        chdirs: resolved.chdirs.map((w) => w.text),
      }
    );
  };
  const rows: [string, string[] | undefined, string[]?][] = [
    ['A=1 git x', ['git', 'x']],
    ['env git x', ['git', 'x']],
    ['/usr/bin/env -i PATH=/b git x', ['git', 'x']],
    ['env -u GH_TOKEN -uX --unset=Y --unset Z gh x', ['gh', 'x']],
    ['env -iu NAME git x', ['git', 'x']],
    ['env -C /d git x', ['git', 'x'], ['/d']],
    ['env -C/d --chdir=e --ch f git x', ['git', 'x'], ['/d', 'e', 'f']],
    ['env --ignore-signal --block-signal=PIPE -0v git x', ['git', 'x']],
    ['env -- git x', ['git', 'x']],
    ['env - A=1 git x', ['git', 'x']],
    ['command git x', ['git', 'x']],
    ['command -p -- git x', ['git', 'x']],
    ['exec -a name -cl git x', ['git', 'x']],
    ['env command exec env git x', ['git', 'x']],
    ['env --help git commit -m wip', undefined],
    ['env --he git commit -m wip', undefined],
    ['env --version git x', undefined],
    ['env -S "printf %s" git x', undefined],
    ['env -iS"printf %s" git x', undefined],
    ['env --split-string=x git x', undefined],
    ['env --bogus git x', undefined],
    ['env -u', undefined],
    ['env A=1', undefined],
    ['command -v git', undefined],
    ['command -V git', undefined],
    ['exec', undefined],
    ['exec > log', undefined],
  ];
  for (const [line, argv, chdirs = []] of rows)
    assert.deepEqual(run(line), argv && { argv, chdirs }, line);
});

test('git global options are read before the subcommand', () => {
  const call = (line: string) => {
    const found = gitCall(commandsOf(line)[0]?.words ?? []);
    return found && [found.dirs.map((w) => w.text), found.verb];
  };
  assert.deepEqual(call('git -C a -c x=y --git-dir g -C b --no-pager commit'), [
    ['a', 'b'],
    'commit',
  ]);
  assert.equal(call('git --help commit'), undefined);
  assert.equal(call('git'), undefined);
  assert.equal(call('echo git commit'), undefined);
});

// Every case an earlier review round reproduced against the three hooks, at the hook decision.
test('each reproduced review case is decided right by its hook', () => {
  const worker = {
    CLAUDE_PROJECT_DIR: '/r',
    KRN_ROLE: 'worker',
    KRN_SCOPE: 'src/',
  };
  const bash = (command: string) => ({
    cwd: '/r',
    tool_name: 'Bash',
    tool_input: { command },
  });
  for (const command of [
    String.raw`cp tasks/input\(old\) src/output`,
    "cp 'tasks/draft(old).txt' src/copy.txt",
    'cp "tasks/a (b).json" src/c',
    'echo "rm tasks/x" > src/notes',
    "cat > src/brief.md <<'EOF'\nrm tasks/x.json\nEOF",
  ])
    assert.equal(scope(bash(command), worker), undefined, command);
  for (const command of [
    'cp src/a tasks/x.json',
    'echo x > "tasks/a b.json"',
    'echo $(rm tasks/x.json)',
    'cd tasks && rm x.json',
    '(cd /r && rm tasks/x.json)',
    'env rm tasks/x.json',
    'command rm tasks/x.json',
    'cp -t tasks src/a',
    'git -C tasks add x.json',
    'sed -n -i s/a/b/ tasks/x.json',
  ])
    assert.match(scope(bash(command), worker) ?? '', /Refused/u, command);

  const commit = (command: string) =>
    commitFormat({ tool_name: 'Bash', tool_input: { command } });
  for (const command of [
    'env --help git commit -m wip',
    "env -S 'printf %s' git commit -m wip",
    'command -v git commit -m wip',
    'git --version commit -m wip',
  ])
    assert.equal(commit(command), undefined, command);
  for (const command of [
    'env -u GH_TOKEN gh pr create --title "bad title"',
    'env GIT_AUTHOR_NAME=bot git commit -m wip',
    'exec git commit -m wip',
    'command git commit -m wip',
    'env git commit -S -m wip',
  ])
    assert.match(commit(command) ?? '', /^Refused/u, command);

  assert.deepEqual(
    targets("git branch -D 'lane x' && git -C . worktree remove w"),
    [
      { kind: 'branch', name: 'lane x' },
      { kind: 'worktree', name: 'w' },
    ],
  );
  assert.deepEqual(targets('echo "git branch -D x"'), []);
});
