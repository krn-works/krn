import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(
  new URL('../../scripts/claude/successor-probe.ts', import.meta.url),
);
const fixtures = fileURLToPath(new URL('../fixtures/herdr/', import.meta.url));

function reply(name: string) {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')).result;
}

// One live Herdr 0.9.1 session: the lead's pane, the probe's shell tab and a
// shell-only tab labelled as the probe's successor, listed together.
const lead = reply('pane-get-lead.reply.jsonl').pane;
const shell = reply('tab-create-probe-shell.reply.jsonl');
const successor = reply('tab-create-probe-successor.reply.jsonl');
const ids = {
  leadPane: lead.pane_id as string,
  leadTab: lead.tab_id as string,
  shellPane: shell.root_pane.pane_id as string,
  shellTab: shell.tab.tab_id as string,
  successorPane: successor.root_pane.pane_id as string,
  successorTab: successor.tab.tab_id as string,
};

// Answers as Herdr 0.9.1 did in the captures: a reply on stdout, a server
// error as JSON on stderr with exit 1, nothing for an admitted `pane run`.
// The probe's shell pane runs the words typed into it at once, so the real
// launcher runs against this stub; every call is logged, each word ended by
// the unit separator. `shell-interrupt` signals the probe, the stub's parent,
// which handles it at its first wait.
const herdrStub = [
  '#!/bin/sh',
  `{ printf '%s\\037' "$@"; printf '\\n'; } >>"$HERDR_CALLS"`,
  'serve() {',
  `  while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done <"$HERDR_FIXTURES/$1"`,
  '}',
  'fail() {',
  '  serve "$1" >&2',
  '  exit 1',
  '}',
  'on() {',
  '  case " $HERDR_MODE " in *" $1 "*) return 0 ;; esac',
  '  return 1',
  '}',
  'case "$1 $2" in',
  "'status ') serve server-status.txt ;;",
  "'pane get')",
  '  if [ "$3" = "$LEAD_PANE" ]; then serve pane-get-lead.reply.jsonl',
  '  else serve pane-get-probe-shell.reply.jsonl; fi ;;',
  "'agent get')",
  '  [ "$3" = "$SUCCESSOR_PANE" ] || fail agent-get-shell.stderr.jsonl',
  '  case "$SUCCESSOR_AGENT" in',
  '  *.stderr.jsonl) fail "$SUCCESSOR_AGENT" ;;',
  '  *) serve "$SUCCESSOR_AGENT" ;;',
  '  esac ;;',
  "'tab create')",
  '  on create-fails && fail tab-create-missing-workspace.stderr.jsonl',
  '  case " $* " in',
  "  *' --label successor-probe-shell '*) serve tab-create-probe-shell.reply.jsonl ;;",
  '  *) serve tab-create-probe-successor.reply.jsonl ;;',
  '  esac ;;',
  "'pane run')",
  '  if [ "$3" = "$SHELL_PANE" ]; then',
  '    on shell-fails && fail pane-run-missing.stderr.jsonl',
  '    on shell-idle && exit 0',
  '    on shell-interrupt && kill -TERM "$PPID" && exit 0',
  '    HERDR_PANE_ID=$3',
  '    export HERDR_PANE_ID',
  '    shift 3',
  '    eval "$*"',
  '    exit 0',
  '  fi',
  '  on successor-fails && fail pane-run-missing.stderr.jsonl',
  '  exit 0 ;;',
  "'tab list')",
  '  on list-fails && fail tab-list-missing-workspace.stderr.jsonl',
  '  serve tab-list-probe.reply.jsonl ;;',
  "'tab close')",
  '  [ "$3" = "$SUCCESSOR_TAB" ] && on close-fails && fail tab-close-missing.stderr.jsonl',
  '  serve tab-close.reply.jsonl ;;',
  '*) exit 64 ;;',
  'esac',
  '',
].join('\n');

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[][];
  scratch: string;
};

type Case = {
  mode?: string;
  agent?: string;
  args?: string[];
};

function readCalls(path: string): string[][] {
  let contents = '';
  try {
    contents = readFileSync(path, 'utf8');
  } catch {}
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\x1f').slice(0, -1));
}

async function runProbe(
  t: { after(fn: () => void): void },
  {
    mode = '',
    agent = 'agent-get-blocked-claude.reply.jsonl',
    args = [],
  }: Case = {},
): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), 'successor-probe-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const scratch = join(root, 'tmp');
  mkdirSync(bin);
  mkdirSync(scratch);
  writeFileSync(join(bin, 'herdr'), herdrStub);
  chmodSync(join(bin, 'herdr'), 0o755);
  const calls = join(root, 'calls');
  const child = spawn(process.execPath, [probe, ...args], {
    env: {
      PATH: bin,
      TMPDIR: scratch,
      HERDR_PANE_ID: ids.leadPane,
      HERDR_CALLS: calls,
      HERDR_FIXTURES: fixtures,
      HERDR_MODE: mode,
      SUCCESSOR_AGENT: agent,
      LEAD_PANE: ids.leadPane,
      SHELL_PANE: ids.shellPane,
      SUCCESSOR_PANE: ids.successorPane,
      SUCCESSOR_TAB: ids.successorTab,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((done) =>
    child.on('close', (code) => done(code)),
  );
  return { status, stdout, stderr, calls: readCalls(calls), scratch };
}

function closes(run: Run): string[] {
  return run.calls
    .filter(([group, verb]) => group === 'tab' && verb === 'close')
    .map((call) => call[2] ?? '');
}

// The launcher runs only in the probe's shell pane, the lead's tab keeps its
// name, both probe tabs close and the scratch cwd is gone.
function assertSafe(run: Run): void {
  for (const call of run.calls) {
    assert.ok(
      !(call[0] === 'pane' && call[1] === 'run' && call[2] === ids.leadPane),
      'the launcher ran in the lead pane',
    );
    assert.notEqual(call.slice(0, 2).join(' '), 'tab rename');
  }
  assert.deepEqual(closes(run), [ids.successorTab, ids.shellTab]);
  assert.deepEqual(readdirSync(run.scratch), []);
}

describe('successor probe', { concurrency: true }, () => {
  it('passes for a successor held on its trust dialog', async (t) => {
    const run = await runProbe(t);
    assert.equal(run.status, 0, run.stderr);
    const out = `successor: herdr tab ${ids.successorTab} pane ${ids.successorPane} agent claude blocked`;
    const err = `successor waits on a startup dialog: answer it in herdr pane ${ids.successorPane} (tab ${ids.successorTab})\nsuccessor retirement skipped: caller agent unavailable`;
    assert.equal(
      run.stdout,
      `successor-probe: PASS; launcher exit 0; stdout ${JSON.stringify(out)}; stderr ${JSON.stringify(err)}; agent claude blocked; closed tabs ${ids.successorTab} ${ids.shellTab}\n`,
    );
    // The shell tab and the successor tab share one scratch cwd in the
    // lead's workspace, and the successor gets the cheapest model.
    const creates = run.calls.filter(
      ([group, verb]) => group === 'tab' && verb === 'create',
    );
    const flag = (call: string[] | undefined, name: string) =>
      call?.[call.indexOf(name) + 1];
    assert.equal(creates.length, 2);
    assert.equal(flag(creates[0], '--workspace'), lead.workspace_id);
    assert.equal(flag(creates[1], '--workspace'), lead.workspace_id);
    assert.equal(flag(creates[1], '--label'), 'successor-probe');
    assert.equal(flag(creates[0], '--cwd'), flag(creates[1], '--cwd'));
    assert.ok(flag(creates[0], '--cwd')?.startsWith(run.scratch));
    const started = run.calls.find(
      ([group, verb, pane]) =>
        group === 'pane' && verb === 'run' && pane === ids.successorPane,
    );
    assert.equal(flag(started, '--model'), 'haiku');
    assertSafe(run);
  });

  const failures: (Case & { name: string; reason: string; exit: string })[] = [
    {
      name: 'a successor that starts working',
      agent: 'agent-get-working-claude.reply.jsonl',
      reason: 'successor agent claude working, expected claude blocked',
      exit: '0',
    },
    {
      name: 'a successor that never shows',
      agent: 'agent-get-missing.stderr.jsonl',
      args: ['--start-seconds', '0'],
      reason: 'launcher exit 1',
      exit: '1',
    },
    {
      name: 'a launcher failing after it created the successor tab',
      mode: 'successor-fails',
      reason: 'launcher exit 1',
      exit: '1',
    },
    {
      name: 'a pane that never runs the launcher',
      mode: 'shell-idle',
      args: ['--wait-seconds', '0'],
      reason: 'launcher did not finish in 0 s',
      exit: 'none',
    },
    {
      name: 'a refused pane run',
      mode: 'shell-fails',
      reason: 'pane run failed: pane_not_found',
      exit: 'none',
    },
    {
      name: 'a refused tab create, sweeping tabs left by an earlier probe',
      mode: 'create-fails',
      reason: 'tab create failed: workspace_not_found',
      exit: 'none',
    },
    {
      name: 'a refused tab list',
      mode: 'list-fails',
      reason: 'tab list failed: workspace_not_found',
      exit: '0',
    },
    {
      name: 'a signal while the launcher runs',
      mode: 'shell-interrupt',
      args: ['--wait-seconds', '60'],
      reason: 'interrupted by SIGTERM',
      exit: 'none',
    },
  ];
  for (const { name, reason, exit, ...probeCase } of failures)
    it(`fails for ${name} and closes both tabs`, async (t) => {
      const run = await runProbe(t, probeCase);
      assert.equal(run.status, 1, run.stderr);
      assert.ok(
        run.stdout.startsWith(
          `successor-probe: FAIL (${reason}); launcher exit ${exit}; `,
        ),
        run.stdout,
      );
      assertSafe(run);
    });

  it('reports a tab it could not close', async (t) => {
    const run = await runProbe(t, { mode: 'close-fails' });
    assert.equal(run.status, 1, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(
        `^successor-probe: FAIL \\(tab close failed: ${ids.successorTab} tab_not_found\\); .*; closed tabs ${ids.shellTab}\\n$`,
        'u',
      ),
    );
    assertSafe(run);
  });

  it('refuses an unknown argument before touching Herdr', async (t) => {
    const run = await runProbe(t, { args: ['--bogus', '1'] });
    assert.equal(run.status, 64);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /invalid argument: --bogus/u);
    assert.deepEqual(run.calls, []);
  });
});
