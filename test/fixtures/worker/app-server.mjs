#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const records = readFileSync(
  new URL('./transcript.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map(JSON.parse);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (value) =>
  appendFileSync(
    process.env.CODEX_TEST_WORKER_LOG,
    `${JSON.stringify(value)}\n`,
  );
const report = {
  status: 'done',
  canary: '',
  summary: 'ok',
  changed_paths: [],
  checks: [],
  findings: [],
  unverified: [],
  blockers: [],
};
const scenario = process.env.CODEX_TEST_WORKER_INPUT;
const threadId =
  scenario === 'long-thread'
    ? 'x'.repeat(1025)
    : scenario === 'secret-thread'
      ? 'sk-synthetic-thread'
      : scenario === 'newline-thread'
        ? 'worker-thread\n'
        : 'worker-thread';
let round = 0;
let current;
let total = 0;
let shellTmp;
let compacting = false;
writeFileSync(process.env.CODEX_TEST_WORKER_PID, String(process.pid));
function notification(method, turnId, text, input = 100) {
  const message = structuredClone(records.find((row) => row.method === method));
  message.params.threadId = threadId;
  message.params.turnId = turnId;
  if (method === 'thread/tokenUsage/updated') {
    total += input;
    const counts = (inputTokens, cachedInputTokens, outputTokens) => ({
      inputTokens,
      cachedInputTokens: scenario === 'unsafe-usage' ? 0 : cachedInputTokens,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    });
    message.params.tokenUsage = {
      last: counts(input, 20, 5),
      total: counts(total, round * 20, round * 5),
      modelContextWindow: 1000,
    };
  } else if (method === 'item/completed') message.params.item.text = text;
  else {
    delete message.params.turnId;
    message.params.turn.id = turnId;
    message.params.turn.items[0].text = text;
  }
  emit(message);
}
createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line);
  log(request);
  const { id, method, params } = request;
  if (!method) return;
  if (method === 'initialize') {
    const gate = process.env.CODEX_TEST_WORKER_INITIALIZE_GATE;
    const deadline = Date.now() + 20000;
    while (gate && !existsSync(gate)) {
      if (Date.now() >= deadline) process.exit(18);
      await delay(10);
    }
    return emit({
      id,
      result: {
        userAgent: `krn/0.166.0`,
        version: process.env.CODEX_TEST_WORKER_VERSION ?? '0.166.0',
      },
    });
  }
  if (method === 'thread/start') {
    shellTmp = params.config?.['shell_environment_policy.set.TMPDIR'];
    return emit({
      id,
      result: {
        thread: {
          id: threadId,
          cliVersion: process.env.CODEX_TEST_WORKER_VERSION ?? '0.166.0',
        },
      },
    });
  }
  if (method === 'thread/compact/start') {
    await delay(Number(process.env.CODEX_TEST_WORKER_COMPACT_ACK_MS ?? 0));
    emit({ id, result: {} });
    if (process.env.CODEX_TEST_WORKER_SLOW_COMPACTION !== '1')
      return emit({
        method: 'item/completed',
        params: {
          threadId,
          turnId: 'compact',
          item: { type: 'contextCompaction', id: 'compact' },
        },
      });
    // Like a live compaction: other items finish first, and a turn started
    // before the compaction item arrives races the summary.
    compacting = true;
    emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId: 'compact',
        item: { type: 'reasoning', id: 'reasoning' },
      },
    });
    emit({
      method: 'item/completed',
      params: {
        threadId: 'other-thread',
        turnId: 'compact',
        item: { type: 'contextCompaction', id: 'other' },
      },
    });
    await delay(300);
    compacting = false;
    return emit(
      process.env.CODEX_TEST_WORKER_COMPACTED_NOTIFICATION === '1'
        ? {
            method: 'thread/compacted',
            params: { threadId, turnId: 'compact' },
          }
        : {
            method: 'item/completed',
            params: {
              threadId,
              turnId: 'compact',
              item: { type: 'contextCompaction', id: 'compact' },
            },
          },
    );
  }
  if (method === 'turn/interrupt') {
    emit({ id, result: {} });
    notification('turn/completed', current, '');
    return;
  }
  if (method === 'thread/unsubscribe') return emit({ id, result: {} });
  if (method !== 'turn/start') return;
  if (compacting) process.exit(21);
  round++;
  current = `turn-${round}`;
  emit({ id, result: { turn: { id: current } } });
  const action = params.input[0].text.trim();
  if (action === 'crash') process.exit(17);
  if (action === 'hang') return;
  if (action === 'hang-child') {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    writeFileSync(process.env.CODEX_TEST_WORKER_ORPHAN_PID, String(child.pid));
    return;
  }
  if (action === 'hang-orphan') {
    setInterval(() => undefined, 1000).ref();
    return;
  }
  if (action === 'bad-usage') {
    emit({
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId: current, tokenUsage: null },
    });
    return;
  }
  if (action.startsWith('index-flag ')) {
    const flag = action.slice('index-flag '.length);
    const updated = spawnSync('git', [
      '-C',
      params.cwd,
      'update-index',
      flag,
      'README.md',
    ]);
    if (updated.status !== 0) process.exit(19);
  }
  if (
    action.startsWith('delete ') ||
    action.startsWith('retype ') ||
    action.startsWith('relink ')
  ) {
    const path = join(params.cwd, action.slice(action.indexOf(' ') + 1));
    rmSync(path, { force: true, recursive: true });
    if (action.startsWith('retype ')) mkdirSync(path);
    if (action.startsWith('relink ')) symlinkSync('changed-target', path);
  }
  if (action === 'malformed') return process.stdout.write('no-json\n');
  if (action === 'crlf') return process.stdout.write('{}\r\n');
  if (action === 'bom') return process.stdout.write('\uFEFF{}\n');
  if (action === 'line-limit')
    return process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
  if (action === 'approval')
    emit({
      id: 'approval',
      method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId: current },
    });
  if (action.startsWith('write ') || action.startsWith('link ')) {
    const path = join(params.cwd, action.slice(action.indexOf(' ') + 1));
    mkdirSync(dirname(path), { recursive: true });
    if (action.startsWith('link ')) symlinkSync('target', path);
    else writeFileSync(path, 'worker edit');
  }
  if (action.startsWith('tmpwrite ')) {
    // Like Codex: a host shell_environment_policy.set.TMPDIR wins over the
    // process environment unless the thread config overrides it.
    const tmp =
      shellTmp ?? process.env.CODEX_TEST_HOST_TMPDIR ?? process.env.TMPDIR;
    writeFileSync(join(tmp, action.slice('tmpwrite '.length)), 'scratch');
  }
  if (action.startsWith('ignore ')) {
    const name = action.slice('ignore '.length);
    appendFileSync(join(params.cwd, '.gitignore'), `\n${name}\n`);
    const path = join(params.cwd, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'worker edit');
  }
  if (action === 'many') {
    const dir = join(params.cwd, 'generated');
    mkdirSync(dir);
    for (let i = 0; i <= 10000; i++)
      writeFileSync(join(dir, `${i}.txt`), 'worker edit');
  }
  let text = JSON.stringify(report);
  if (action === 'invalid') text = '{}';
  if (action === 'oversized') text = 'x'.repeat(256 * 1024 + 1);
  if (action === 'report-secrets')
    text = JSON.stringify({
      ...report,
      summary: readFileSync(process.env.CODEX_TEST_WORKER_REPORT, 'utf8'),
    });
  if (action === 'wrong-thread-usage')
    emit({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'other-thread', turnId: current, tokenUsage: null },
    });
  if (action === 'wrong-turn-usage')
    notification('thread/tokenUsage/updated', 'previous-turn', text);
  if (!['no-usage', 'wrong-thread-usage', 'wrong-turn-usage'].includes(action))
    notification(
      'thread/tokenUsage/updated',
      current,
      text,
      scenario === 'unsafe-usage'
        ? Number.MAX_SAFE_INTEGER
        : action === 'large'
          ? 600
          : action === 'budget'
            ? 2000000
            : 100,
    );
  notification('item/completed', current, text);
  notification('turn/completed', current, text);
});
