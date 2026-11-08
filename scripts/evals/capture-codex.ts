// Re-captures the Codex receiver cases of test/fixtures/eval/codex-<version>
// against the installed binary, byte for byte, into a new directory.
// usage: node scripts/evals/capture-codex.ts [--codex <bin>] [--model <model>] [--out <dir>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_CONFIG } from '../../src/evals/session.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const which = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' });
const codex = realpathSync(flag('--codex', which.stdout.trim()));
const model = flag('--model', 'gpt-6.1-sol');
const login = join(homedir(), '.codex', 'auth.json');
const prompt = 'Reply with OK.\n';
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
// Built in JavaScript: a shell `$(...)` strips the final newline, and the TOML
// then runs `skills = false` into the last line.
const config = (name: string) =>
  `model = ${JSON.stringify(name)}\n${CODEX_CONFIG}`;

const version = spawnSync(codex, ['--version']);
const receiver = version.stdout.toString().trim();
const match = /^codex-cli (\S+)$/u.exec(receiver);
if (version.status !== 0 || !match) {
  process.stderr.write(`capture-codex: unexpected --version: ${receiver}\n`);
  process.exit(70);
}
const out = resolve(
  flag('--out', join(root, 'test/fixtures/eval', `codex-${match[1]}`)),
);
if (existsSync(out)) {
  process.stderr.write(
    `capture-codex: ${out} exists; captures are never overwritten\n`,
  );
  process.exit(65);
}

type Case = {
  name: string;
  question: string;
  model: string;
  config: string;
  configBytes: string;
  login?: string;
  env?: NodeJS.ProcessEnv;
};
const cases: Case[] = [
  {
    name: 'turn-failed',
    question: 'Does turn.failed carry usage?',
    model: 'krn-capture-unknown-model',
    config: 'the session config for the model, byte for byte',
    configBytes: config('krn-capture-unknown-model'),
  },
  {
    name: 'config-ignored',
    question:
      'How does Codex report an ignored or unrecognised setting in --json mode?',
    model,
    config:
      'the session config for the model plus `skills = false` under [features]',
    configBytes: `${config(model)}skills = false\n`,
  },
  {
    name: 'mask-exit-70',
    question: 'What does the session see when the mask exits 70?',
    model,
    config:
      'the session config for the model; the mask ran with PATH=/nonexistent, so spawning bwrap failed and Codex never started',
    configBytes: config(model),
    env: { PATH: '/nonexistent' },
  },
  {
    name: 'startup-failed',
    question: 'What does Codex print when it fails before its first event?',
    model,
    config:
      'the session config for the model with `skills = false` run into its last line (`memories = falseskills = false`), which TOML rejects',
    configBytes: `${config(model).slice(0, -1)}skills = false\n`,
  },
  {
    name: 'retry-failed',
    question: 'How does Codex report a retried request?',
    model,
    config:
      'the session config for the model; <login> was a file holding {} so ChatGPT authentication failed on every retry',
    configBytes: config(model),
    login: '{}',
  },
];

mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(dirname(out), '.capture-codex-'));
const captures: unknown[] = [];
const record = (
  entry: Record<string, unknown>,
  name: string,
  exitCode: number,
  stdout: Buffer,
  stderr: Buffer,
  stdoutFile: string,
) => {
  writeFileSync(join(out, stdoutFile), stdout);
  writeFileSync(join(out, `${name}.stderr.log`), stderr);
  captures.push({
    ...entry,
    exitCode,
    stdout: { file: stdoutFile, sha256: sha256(stdout) },
    stderr: { file: `${name}.stderr.log`, sha256: sha256(stderr) },
  });
  process.stdout.write(`${name}: exit ${exitCode}\n`);
};
try {
  for (const item of cases) {
    const slot = join(work, item.name);
    mkdirSync(join(slot, 'repo'), { recursive: true });
    mkdirSync(join(slot, 'codex'));
    for (const git of [
      ['init', '-q'],
      [
        '-c',
        'user.name=krn',
        '-c',
        'user.email=krn@localhost',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'empty',
      ],
    ])
      spawnSync('git', git, { cwd: join(slot, 'repo'), stdio: 'ignore' });
    const configFile = join(slot, 'codex', 'config.toml');
    writeFileSync(configFile, item.configBytes, { mode: 0o444 });
    let credential = login;
    if (item.login !== undefined) {
      credential = join(work, `${item.name}.auth.json`);
      writeFileSync(credential, item.login);
    }
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'src/cli/main.ts'),
        'eval',
        'mask',
        '--slot',
        slot,
        '--network',
        '--tool',
        dirname(codex),
        '--tool',
        dirname(process.execPath),
        '--credential',
        `${credential}=/w/codex/auth.json`,
        '--credential',
        `${configFile}=/w/codex/config.toml`,
        '--',
        '/usr/bin/env',
        'CODEX_HOME=/w/codex',
        codex,
        'exec',
        '--json',
        '--ephemeral',
        '--model',
        item.model,
        '--sandbox',
        'workspace-write',
        '--cd',
        '/w/repo',
        '--color',
        'never',
        '-',
      ],
      { input: prompt, env: { ...process.env, ...item.env }, timeout: 600_000 },
    );
    chmodSync(configFile, 0o644);
    const { configBytes: _, login: __, env: ___, ...entry } = item;
    record(
      entry,
      item.name,
      run.status ?? 70,
      run.stdout,
      run.stderr,
      `${item.name}.stdout.jsonl`,
    );
  }
  record(
    {
      name: 'version',
      question:
        'What does codex --version print? krn eval session records this line and refuses an uncaptured version.',
      command: '<codex> --version',
    },
    'version',
    version.status ?? 70,
    version.stdout,
    version.stderr,
    'version.stdout.txt',
  );
  writeFileSync(
    join(out, 'provenance.json'),
    `${JSON.stringify(
      {
        receiver,
        captured: new Date().toISOString().slice(0, 10),
        command:
          'node src/cli/main.ts eval mask --slot <slot> --network --tool <codex-bin-dir> --tool <node-bin-dir> --credential <login>=/w/codex/auth.json --credential <slot>/codex/config.toml=/w/codex/config.toml -- /usr/bin/env CODEX_HOME=/w/codex <codex> exec --json --ephemeral --model <model> --sandbox workspace-write --cd /w/repo --color never -',
        setup: `Recorded by scripts/evals/capture-codex.ts: the argv krn eval session passes to the mask (src/evals/session.ts), run without the systemd scope. stdin is the prompt "Reply with OK.\\n". <slot> holds repo/ (a git repository with one empty commit) and codex/config.toml (mode 0444) built from CODEX_CONFIG; <codex> is ${codex}; <login> is ~/.codex/auth.json unless a capture says otherwise. Each capture records stdout and stderr byte for byte; nothing was redacted.`,
        captures,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `captured ${receiver} into ${out}; add ${match[1]} to CAPTURED_CODEX_VERSIONS in src/evals/receiver.ts\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
