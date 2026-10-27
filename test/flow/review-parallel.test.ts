import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runReview } from '../../src/flow/index.ts';
import { ReviewAbortedError } from '../../src/flow/panel.ts';
import type { ReviewRole } from '../../src/flow/types.ts';
import { CodexHost, type CodexSessionResult } from '../../src/hosts/codex.ts';
import {
  CONDITION_WAIT_MS,
  conditionTimeoutFor,
  waitForCondition,
} from '../helpers/condition-wait.ts';
import { requiresIsolation } from '../helpers/isolation.ts';

type JudgeEvent = {
  readonly type: 'start' | 'end';
  readonly role: ReviewRole;
  readonly pid: number;
  readonly status?: 'complete' | 'failed' | 'terminated';
};

type FixtureOptions = {
  readonly failRole?: ReviewRole;
};

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(options: FixtureOptions = {}) {
  const parent = join(process.cwd(), '.krn', 'tmp', 'review-parallel');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'fixture-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'KRN test');
  git(root, 'config', 'user.email', 'krn-test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture base');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
  git(root, 'add', 'src.ts');
  git(root, 'commit', '-qm', 'review target');
  const head = git(root, 'rev-parse', 'HEAD');
  const lens = join(root, 'lens.txt');
  const eventsPath = join(root, 'judge-events.jsonl');
  const executable = join(root, 'codex-stub.mjs');
  writeFileSync(lens, 'Check acceptance and behaviour.\n');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, watch } from 'node:fs';
const eventsPath = ${JSON.stringify(eventsPath)};
const controlRoot = ${JSON.stringify(root)};
const failRole = ${JSON.stringify(options.failRole ?? null)};
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const role = /ROLE: (standards|spec|adversarial)/u.exec(prompt)?.[1];
if (!role) process.exit(90);
function event(type, status) {
  appendFileSync(eventsPath, JSON.stringify({ type, role, pid: process.pid, status }) + '\\n');
}
let finished = false;
function finish(status, exitCode) {
  if (finished) return;
  finished = true;
  gate.close();
  event('end', status);
  process.exitCode = exitCode;
}
function released() {
  if (finished || !existsSync(controlRoot + '/release-' + role)) return;
  const message = JSON.stringify({ verdict: 'PASS', findings: [] });
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) + '\\n');
  finish(failRole === role ? 'failed' : 'complete', failRole === role ? 7 : 0);
}
const gate = watch(controlRoot, released);
process.once('SIGTERM', () => finish('terminated', 143));
event('start');
released();
`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);

  return {
    root,
    base,
    head,
    lens,
    eventsPath,
    executable,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function readEvents(path: string): JudgeEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JudgeEvent);
}

function completedCodexResult(sessionId: string): CodexSessionResult {
  const finalMessage = JSON.stringify({ verdict: 'PASS', findings: [] });
  return {
    sessionId,
    reasonKind: 'agent_message',
    reasonSha256: 'a'.repeat(64),
    reasonLength: finalMessage.length,
    claimsDone: true,
    finalMessage,
    exitCode: 0,
    signal: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    usageObservation: {
      turnsStarted: 1,
      turnsCompleted: 1,
      invalidFields: 0,
    },
  };
}

async function waitForStarts(
  path: string,
  count: number,
): Promise<JudgeEvent[]> {
  return waitForCondition(() => {
    const events = readEvents(path);
    const starts = events.filter((event) => event.type === 'start');
    return starts.length >= count ? events : undefined;
  }, `all ${count} judge processes to report start events`);
}

const panel: readonly ReviewRole[] = ['standards', 'spec', 'adversarial'];

// A serial implementation cannot satisfy the start barrier. Releasing each
// role only after its predecessor ended also makes completion order explicit.
async function runReleasedReview(
  sample: ReturnType<typeof fixture>,
  roles: readonly ReviewRole[] = panel,
) {
  const controller = new AbortController();
  const review = runReview({
    repo: sample.root,
    base: sample.base,
    head: sample.head,
    lens: sample.lens,
    panel: roles,
    codexExecutable: sample.executable,
    timeoutMs: 2 * CONDITION_WAIT_MS,
    signal: controller.signal,
  });
  void review.catch(() => undefined);
  try {
    await waitForStarts(sample.eventsPath, roles.length);
    for (const role of [...roles].reverse()) {
      writeFileSync(join(sample.root, `release-${role}`), 'release');
      await waitForCondition(
        () =>
          readEvents(sample.eventsPath).some(
            (event) => event.type === 'end' && event.role === role,
          )
            ? true
            : undefined,
        `the released ${role} judge to report its end event`,
      );
    }
    return await review;
  } finally {
    controller.abort();
    await review.catch(() => undefined);
  }
}

test('runReview settles panel judge sessions concurrently', {
  timeout: conditionTimeoutFor(1),
}, async () => {
  const sample = fixture();
  const originalStart = CodexHost.prototype.start;
  const events: {
    readonly type: 'start' | 'end';
    readonly role: ReviewRole;
  }[] = [];
  const waiting = new Set<ReviewRole>();
  const completionOrder = [...panel].reverse();
  CodexHost.prototype.start = async (input) => {
    const match = /ROLE: (standards|spec|adversarial)/u.exec(input.prompt);
    assert.ok(match?.[1]);
    const role = match[1] as ReviewRole;
    events.push({ type: 'start', role });
    const sessionId = `fake-review-${role}`;
    return {
      id: sessionId,
      wait: async () => {
        waiting.add(role);
        const predecessor = completionOrder[completionOrder.indexOf(role) - 1];
        await waitForCondition(
          () =>
            waiting.size === panel.length &&
            (predecessor === undefined ||
              events.some(
                (event) => event.type === 'end' && event.role === predecessor,
              ))
              ? true
              : undefined,
          `all judge waits to enter and ${predecessor ?? 'the last-started judge'} to release ${role}`,
        );
        events.push({ type: 'end', role });
        return completedCodexResult(sessionId);
      },
    };
  };

  try {
    const record = await runReview({
      repo: sample.root,
      base: sample.base,
      head: sample.head,
      lens: sample.lens,
      codexExecutable: sample.executable,
    });
    const firstEnd = events.findIndex((event) => event.type === 'end');
    assert.equal(firstEnd, 3, 'all judges must start before any one finishes');
    assert.deepEqual(
      events.filter((event) => event.type === 'end').map((event) => event.role),
      [...panel].reverse(),
    );
    assert.deepEqual(
      record.judges.map((judge) => judge.role),
      panel,
    );
  } finally {
    CodexHost.prototype.start = originalStart;
    sample.cleanup();
  }
});

test('a thrown judge is recorded incomplete and retains the other verdicts', {
  timeout: conditionTimeoutFor(1),
}, async () => {
  const sample = fixture();
  const originalStart = CodexHost.prototype.start;
  const failure = new Error('judge startup failed');
  const events: {
    readonly type: 'start' | 'end';
    readonly role: ReviewRole;
  }[] = [];
  CodexHost.prototype.start = async (input) => {
    const match = /ROLE: (standards|spec|adversarial)/u.exec(input.prompt);
    assert.ok(match?.[1]);
    const role = match[1] as ReviewRole;
    events.push({ type: 'start', role });
    if (role === 'spec') throw failure;
    const sessionId = `fake-review-${role}`;
    return {
      id: sessionId,
      wait: async () => {
        await waitForCondition(
          () =>
            events.filter((event) => event.type === 'start').length ===
            panel.length
              ? true
              : undefined,
          `all judges, including the rejected judge, to start before ${role} finishes`,
        );
        events.push({ type: 'end', role });
        return completedCodexResult(sessionId);
      },
    };
  };

  try {
    const record = await runReview({
      repo: sample.root,
      base: sample.base,
      head: sample.head,
      lens: sample.lens,
      codexExecutable: sample.executable,
    });
    assert.equal(events.filter((event) => event.type === 'start').length, 3);
    assert.equal(events.filter((event) => event.type === 'end').length, 2);
    assert.deepEqual(
      record.judges.map((judge) => judge.role),
      panel,
    );
    for (const index of [0, 2]) {
      const judge = record.judges[index];
      assert.ok(judge?.state === 'complete' && judge.verdict === 'PASS');
    }
    const rejected = record.judges[1];
    assert.ok(rejected?.state === 'incomplete');
    assert.equal(rejected.reason, 'nonzero_exit');
    assert.equal(rejected.reasonKind, 'process_exit');
    assert.equal(rejected.exitCode, null);
    assert.equal(rejected.finalMessage, failure.message);
    assert.equal(record.panelVerdict, 'INCOMPLETE');
  } finally {
    CodexHost.prototype.start = originalStart;
    sample.cleanup();
  }
});

test('an all-rejected panel records every judge incomplete', async () => {
  const sample = fixture();
  const originalStart = CodexHost.prototype.start;
  CodexHost.prototype.start = async (input) => {
    const match = /ROLE: (standards|spec|adversarial)/u.exec(input.prompt);
    assert.ok(match?.[1]);
    throw new Error(`${match[1]} judge startup failed`);
  };

  try {
    const record = await runReview({
      repo: sample.root,
      base: sample.base,
      head: sample.head,
      lens: sample.lens,
      codexExecutable: sample.executable,
    });
    assert.deepEqual(
      record.judges.map((judge) => judge.role),
      panel,
    );
    assert.ok(record.judges.every((judge) => judge.state === 'incomplete'));
    assert.equal(record.panelVerdict, 'INCOMPLETE');
  } finally {
    CodexHost.prototype.start = originalStart;
    sample.cleanup();
  }
});

test('an aborted panel with a rejected judge still throws ReviewAbortedError', async () => {
  const sample = fixture();
  const originalStart = CodexHost.prototype.start;
  const controller = new AbortController();
  CodexHost.prototype.start = async () => {
    controller.abort();
    throw new Error('judge startup failed');
  };

  try {
    await assert.rejects(
      runReview({
        repo: sample.root,
        base: sample.base,
        head: sample.head,
        lens: sample.lens,
        codexExecutable: sample.executable,
        signal: controller.signal,
      }),
      ReviewAbortedError,
    );
  } finally {
    CodexHost.prototype.start = originalStart;
    sample.cleanup();
  }
});

test('review starts panel judges together and records panel order', {
  timeout: conditionTimeoutFor(4),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'review starts panel judges together and records panel order',
      ['systemdUserScope'],
    )
  )
    return;
  const sample = fixture();
  try {
    const record = await runReleasedReview(sample);
    const events = readEvents(sample.eventsPath);
    const firstEnd = events.findIndex((event) => event.type === 'end');
    assert.equal(events.filter((event) => event.type === 'start').length, 3);
    assert.equal(firstEnd, 3, 'all judges must start before any one finishes');
    assert.deepEqual(
      events.filter((event) => event.type === 'end').map((event) => event.role),
      [...panel].reverse(),
    );
    assert.deepEqual(
      record.judges.map((judge) => judge.role),
      panel,
    );
    assert.equal(record.panelVerdict, 'PASS');
  } finally {
    sample.cleanup();
  }
});

test('a nonzero judge exit retains the other panel verdicts', {
  timeout: conditionTimeoutFor(4),
}, async (t) => {
  if (
    !requiresIsolation(
      t,
      'a nonzero judge exit retains the other panel verdicts',
      ['systemdUserScope'],
    )
  )
    return;
  const sample = fixture({ failRole: 'spec' });
  try {
    const record = await runReleasedReview(sample);
    assert.deepEqual(
      record.judges.map((judge) => judge.role),
      panel,
    );
    assert.equal(record.judges[0]?.state, 'complete');
    assert.equal(
      record.judges[0]?.state === 'complete'
        ? record.judges[0].verdict
        : undefined,
      'PASS',
    );
    assert.equal(record.judges[1]?.state, 'incomplete');
    assert.equal(
      record.judges[1]?.state === 'incomplete'
        ? record.judges[1].reason
        : undefined,
      'nonzero_exit',
    );
    assert.equal(record.judges[2]?.state, 'complete');
    assert.equal(
      record.judges[2]?.state === 'complete'
        ? record.judges[2].verdict
        : undefined,
      'PASS',
    );
    assert.equal(record.panelVerdict, 'INCOMPLETE');
  } finally {
    sample.cleanup();
  }
});

test('aborting a panel terminates every judge process', {
  timeout: conditionTimeoutFor(4),
}, async (t) => {
  if (
    !requiresIsolation(t, 'aborting a panel terminates every judge process', [
      'systemdUserScope',
    ])
  )
    return;
  const sample = fixture();
  const controller = new AbortController();
  let review: ReturnType<typeof runReview> | undefined;
  try {
    review = runReview({
      repo: sample.root,
      base: sample.base,
      head: sample.head,
      lens: sample.lens,
      codexExecutable: sample.executable,
      timeoutMs: 2 * CONDITION_WAIT_MS,
      signal: controller.signal,
    });
    void review.catch(() => undefined);
    await Promise.race([
      waitForStarts(sample.eventsPath, 3),
      review.then(() => {
        assert.fail('review completed before all judge processes started');
      }),
    ]);
    controller.abort();
    await assert.rejects(review, ReviewAbortedError);
    const ended = readEvents(sample.eventsPath).filter(
      (event) => event.type === 'end',
    );
    assert.equal(ended.length, 3);
    assert.ok(ended.every((event) => event.status === 'terminated'));
    for (const { pid } of ended)
      assert.throws(
        () => process.kill(pid, 0),
        { code: 'ESRCH' },
        `judge process ${pid} must be terminated`,
      );
  } finally {
    controller.abort();
    await review?.catch(() => undefined);
    sample.cleanup();
  }
});

test('a one-role panel remains partial', {
  timeout: conditionTimeoutFor(4),
}, async (t) => {
  if (
    !requiresIsolation(t, 'a one-role panel remains partial', [
      'systemdUserScope',
    ])
  )
    return;
  const sample = fixture();
  try {
    const record = await runReleasedReview(sample, ['spec']);
    assert.equal(record.panel?.partial, true);
    assert.deepEqual(record.panel?.requestedRoles, ['spec']);
    assert.deepEqual(
      record.judges.map((judge) => judge.role),
      ['spec'],
    );
    assert.equal(record.panelVerdict, 'INCOMPLETE');
  } finally {
    sample.cleanup();
  }
});
