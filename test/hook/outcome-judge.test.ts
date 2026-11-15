import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claudeJudge,
  JUDGE_LOG,
  JUDGE_MODEL,
  JUDGE_TIMEOUT_MS,
  type JudgeCall,
  judgeReplyFrom,
  outcomeLines,
  outcomeRefusal,
  parseVerdict,
  transcriptTail,
} from '../../src/hook/outcome-judge.ts';
import { judgeStop } from '../../src/hook/stop.ts';

const capture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
/** A lane that only read files: the outcome below is not in it. */
const missingCapture = capture('d23-transcript/session.jsonl');
/** A lane whose last turns print `delivered: <sha>`. */
const provenCapture = capture('outcome-ledger/transcript.jsonl');

const body = `Why: a lane can satisfy every arm yet miss the outcome.
Outcome: krn deliver merges PR 181 and prints a delivered line with the merge sha.
Proof: the transcript shows the line \`delivered: <sha>\`.`;

/** The stubbed judge reply: proven when the prompt carries the delivered line, else the item is missing. */
const stub: JudgeCall = (prompt) => ({
  reply: prompt.includes('delivered: 903bcdd')
    ? 'proven'
    : 'missing: the delivered line with the merge sha',
  costUsd: 0.004,
});

function sh(cwd: string, ...args: string[]) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
}

function clone() {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-judge-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'a@b.c');
  sh(dir, 'config', 'user.name', 'a');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'change');
  return dir;
}

const env = (dir: string, extra: NodeJS.ProcessEnv = {}) => ({
  CLAUDE_PROJECT_DIR: dir,
  KRN_SESSION_CLASS: 'lane',
  KRN_SCOPE: 'src/',
  KRN_TEST_FIRST: '0',
  KRN_ACCEPTANCE_CLAUSES: '0',
  KRN_TASK_BODY: body,
  KRN_TASK: 't-x',
  ...extra,
});
const payload = (dir: string, transcript: string, session = 's1') => ({
  cwd: dir,
  session_id: session,
  transcript_path: transcript,
  last_assistant_message: 'finished',
});
const green = () => [];
const log = (dir: string) =>
  readFileSync(join(dir, JUDGE_LOG), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

function inClone(run: (dir: string) => void) {
  const dir = clone();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('clause 5: a Stop is refused when the transcript does not show the task Outcome, and passes when it does', () => {
  inClone((dir) => {
    const refusal = judgeStop(
      payload(dir, missingCapture),
      env(dir),
      green,
      'work',
      undefined,
      green,
      stub,
    );
    assert.match(refusal ?? '', /outcome judge/u);
    assert.match(refusal ?? '', /the delivered line with the merge sha/u);
    assert.equal(
      judgeStop(
        payload(dir, provenCapture, 's2'),
        env(dir),
        green,
        'work',
        undefined,
        green,
        stub,
      ),
      undefined,
    );
  });
});

test('clause 7: the judge is Haiku 5.5', () => {
  assert.equal(JUDGE_MODEL, 'claude-haiku-5-5');
});

test('clause 8: the judge refuses once, KRN_OUTCOME_JUDGE=0 opts out, an unavailable judge passes with a logged skip within 60 s', () => {
  inClone((dir) => {
    const ask = (extra: NodeJS.ProcessEnv, judge: JudgeCall) =>
      outcomeRefusal(
        dir,
        env(dir, extra),
        payload(dir, missingCapture),
        body,
        judge,
      );
    assert.match(ask({}, stub) ?? '', /the delivered line/u);
    // Refused once: the same session is not held again.
    assert.equal(ask({}, stub), undefined);
    assert.equal(JUDGE_TIMEOUT_MS, 60_000);
  });
  inClone((dir) => {
    const never: JudgeCall = () => assert.fail('the judge must not be called');
    assert.equal(
      outcomeRefusal(
        dir,
        env(dir, { KRN_OUTCOME_JUDGE: '0' }),
        payload(dir, missingCapture),
        body,
        never,
      ),
      undefined,
    );
    assert.equal(existsSync(join(dir, JUDGE_LOG)), false);
  });
  inClone((dir) => {
    const down: JudgeCall = () => ({
      unavailable: 'judge unavailable: ENOENT',
    });
    assert.equal(
      outcomeRefusal(dir, env(dir), payload(dir, missingCapture), body, down),
      undefined,
    );
    const [entry] = log(dir);
    assert.equal(entry?.verdict, 'skip');
    assert.match(String(entry?.reason), /ENOENT/u);
  });
});

test('clause 9: the cost of every judge answer is logged per lane', () => {
  inClone((dir) => {
    outcomeRefusal(dir, env(dir), payload(dir, provenCapture), body, stub);
    const [entry] = log(dir);
    assert.equal(entry?.verdict, 'proven');
    assert.equal(entry?.costUsd, 0.004);
    assert.equal(entry?.task, 't-x');
  });
});

test('clause 10: the transcript tail of a verbatim capture reaches the judge prompt with the Outcome and Proof lines', () => {
  const tail = transcriptTail(provenCapture);
  assert.match(tail, /delivered: 903bcdd2/u);
  assert.deepEqual(outcomeLines(body), {
    outcome:
      'krn deliver merges PR 181 and prints a delivered line with the merge sha.',
    proof: 'the transcript shows the line `delivered: <sha>`.',
  });
  assert.equal(outcomeLines('Why: nothing'), undefined);
  assert.deepEqual(parseVerdict('proven'), { proven: true });
  assert.deepEqual(parseVerdict('Missing: the test'), {
    proven: false,
    item: 'the test',
  });
  assert.equal(parseVerdict('maybe'), undefined);
});

test('clause 11: no test makes a real model call', () => {
  const answer = claudeJudge('prompt', { ...process.env });
  assert.ok(
    'unavailable' in answer,
    'the real judge skips under the test runner',
  );
});

test('the judge reads the reply and cost from a verbatim headless claude result', () => {
  const stdout = readFileSync(
    capture('claude/headless-session-result.json'),
    'utf8',
  );
  const answer = judgeReplyFrom(stdout);
  assert.ok('reply' in answer);
  assert.equal(typeof answer.costUsd, 'number');
  assert.ok('unavailable' in judgeReplyFrom('not json'));
});
