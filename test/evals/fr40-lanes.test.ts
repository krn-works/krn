import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifySession,
  decide,
  gap,
  laneBrief,
  laneConfigSha256,
  tokenRatio,
  totalTokens,
  type Unit,
} from '../../evals/fr40/lanes.ts';
import { score } from '../../evals/fr40/scorers.ts';
import type { ConventionTask } from '../../evals/fr40/tasks.ts';

const frozen = fileURLToPath(new URL('../../evals/fr40/', import.meta.url));
const read = async (name: string) =>
  JSON.parse(await readFile(join(frozen, name), 'utf8'));

test('arm A is the bare brief; arm B is the carrier prefix over the same brief', async () => {
  const tasks: ConventionTask[] = await read('tasks.json');
  const material = await read('material.json');
  for (const task of [tasks[0], tasks[40], tasks[132]]) {
    assert.ok(task);
    const a = laneBrief(task, 'A');
    const b = laneBrief(task, 'B');
    assert.equal(a.prompt, `${task.prompt.trim()}\n`);
    assert.equal(a.prefix, '');
    assert.ok(b.prompt.endsWith(`\n\n${a.prompt}`));
    // The prefix carries the frozen arm-B packet text byte for byte.
    assert.match(
      b.prefix,
      /^Repository conventions \(brain packet [0-9a-f]{12}\):\n/u,
    );
    assert.ok(b.prefix.includes(material[task.id].packet));
    assert.ok(!a.prompt.includes('Repository conventions'));
  }
});

test('a B brief whose packet is empty is refused as arm leakage', async () => {
  const [task] = (await read('tasks.json')) as ConventionTask[];
  assert.ok(task);
  assert.throws(
    () =>
      laneBrief(task, 'B', () => ({
        arm: 'brain',
        task: task.id,
        asOf: '2026-11-08',
        budget: 0,
        tokens: 0,
        records: [],
        text: '',
        sha256: '',
      })),
    /no carrier prefix/u,
  );
});

test('the frozen scorer grades a lane slot: no commit fails, a task-id title passes', async () => {
  const tasks: ConventionTask[] = await read('tasks.json');
  const task = tasks.find((t) => t.template === 'commit-title-id');
  assert.ok(task);
  const dir = await mkdtemp(join(tmpdir(), 'fr40lane-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@example.invalid');
    git('config', 'user.name', 'a');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    assert.equal(score(task, dir, base).pass, false);
    git('commit', '-q', '--allow-empty', '-m', `Add it (${task.taskId})`);
    assert.equal(score(task, dir, base).pass, true);
    git('commit', '-q', '--allow-empty', '-m', 'No id here');
    assert.equal(score(task, dir, base).pass, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const usage = {
  input_tokens: 4,
  output_tokens: 6,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 100,
};
const ok = JSON.stringify({
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.4,
  usage,
});

test('session results classify as completed, cap or invalid', () => {
  assert.deepEqual(classifySession(ok, 0, false), {
    status: 'completed',
    usage,
    cost: 0.4,
  });
  assert.equal(totalTokens(usage), 120);
  assert.equal(classifySession('', null, true).status, 'cap');
  assert.equal(
    classifySession(
      JSON.stringify({ subtype: 'error_max_turns', total_cost_usd: 1 }),
      1,
      false,
    ).status,
    'cap',
  );
  assert.equal(classifySession('not json', 1, false).status, 'invalid');
  assert.equal(classifySession(ok, 1, false).status, 'invalid');
  assert.equal(
    classifySession(
      JSON.stringify({
        subtype: 'success',
        is_error: true,
        total_cost_usd: 0,
        usage,
      }),
      0,
      false,
    ).status,
    'invalid',
  );
});

const unit = (
  n: number,
  a: 'pass' | 'fail',
  b: 'pass' | 'fail',
  ta = 100,
  tb = 100,
): Unit => ({
  task: `t${n}`,
  stratum: 's',
  a,
  b,
  tokensA: ta,
  tokensB: tb,
});

test('the preregistered rule: early stop at B-A <= 0, KEEP needs +15 pp, p and tokens', () => {
  const flat = Array.from({ length: 20 }, (_, i) => unit(i, 'pass', 'pass'));
  assert.equal(decide(flat, 133), 'STOP');
  const up = [...flat.slice(1), unit(99, 'fail', 'pass')];
  assert.equal(decide(up, 133), 'CONTINUE');
  const big = Array.from({ length: 133 }, (_, i) =>
    i < 25 ? unit(i, 'fail', 'pass') : unit(i, 'pass', 'pass'),
  );
  assert.equal(decide(big, 133), 'KEEP');
  assert.equal(
    decide(
      big.map((u) => ({ ...u, tokensB: 130 })),
      133,
    ),
    'EPITAPH',
  );
  const small = Array.from({ length: 133 }, (_, i) =>
    i < 15 ? unit(i, 'fail', 'pass') : unit(i, 'pass', 'pass'),
  );
  assert.equal(decide(small, 133), 'EPITAPH');
  assert.equal(gap(big).wins, 25);
  assert.equal(tokenRatio(big), 1);
});

test('the lane config hash is stable and names the pinned model and tools', () => {
  assert.match(laneConfigSha256(), /^[0-9a-f]{64}$/u);
  assert.equal(
    laneConfigSha256(),
    createHash('sha256')
      .update(
        JSON.stringify({
          args: JSON.parse(
            JSON.stringify([
              '-p',
              '--model',
              'claude-sonnet-5-5',
              '--output-format',
              'json',
              '--tools',
              'Bash,Read,Edit,Write,Glob,Grep',
              '--permission-mode',
              'bypassPermissions',
              '--strict-mcp-config',
              '--disable-slash-commands',
              '--no-session-persistence',
              '--setting-sources',
              'user',
            ]),
          ),
          env: {
            CLAUDE_CODE_SESSION_ATTENDED: '0',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
          },
        }),
      )
      .digest('hex'),
  );
});
