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
import { adoptionGaps } from '../../src/adopt/gaps.ts';
import { remediateHost } from '../../src/adopt/host-remediation.ts';
import { listDecisions, openDecisionOnce } from '../../src/cli/decide.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-host-remediation-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const fail = (id: string) =>
  ({ id, message: 'exit 1', tier: 'reflex' }) as const;

test('a failing CI standard gets the stack workflow from the skeleton, with the install step', () => {
  const root = repo({
    'package.json': '{"name":"x","scripts":{"test":"node --test"}}\n',
    'package-lock.json': '{}\n',
  });
  try {
    const done = remediateHost(root, [fail('s-ci-runs-tests')]);
    assert.deepEqual(done.written, ['.github/workflows/ci.yml']);
    const text = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    assert.match(text, /pull_request:/u);
    assert.match(text, /npm ci && npm test/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a python repository gets the unittest workflow and an existing ci.yml is kept beside krn-ci.yml', () => {
  const root = repo({
    'requirements.txt': 'x\n',
    'tests/test_a.py': '',
    '.github/workflows/ci.yml': 'name: own\non: push\n',
  });
  try {
    const done = remediateHost(root, [fail('s-ci-runs-tests')]);
    assert.deepEqual(done.written, ['.github/workflows/krn-ci.yml']);
    assert.match(
      readFileSync(join(root, '.github/workflows/krn-ci.yml'), 'utf8'),
      /pip install -r requirements\.txt && python -m unittest discover -s tests/u,
    );
    assert.equal(
      readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      'name: own\non: push\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failing lockfile standard writes and stages package-lock.json with the real npm', () => {
  const root = repo({
    'package.json': '{"name":"lockme","version":"1.0.0"}\n',
  });
  try {
    const done = remediateHost(root, [fail('s-lockfile-committed')]);
    assert.deepEqual(done.written, ['package-lock.json']);
    assert.ok(existsSync(join(root, 'package-lock.json')));
    const tracked = spawnSync('git', ['ls-files'], {
      cwd: root,
      encoding: 'utf8',
    }).stdout;
    assert.match(tracked, /package-lock\.json/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a standard that passes is left alone and an unwritable lockfile is reported, not thrown', () => {
  const root = repo({
    'package.json':
      '{"name":"bad","dependencies":{"krn-no-such-package-xyz":"99.0.0"}}\n',
  });
  try {
    assert.deepEqual(remediateHost(root, []), { written: [], unfixed: [] });
    const done = remediateHost(root, [fail('s-lockfile-committed')]);
    assert.deepEqual(done.written, []);
    assert.match(
      done.unfixed[0] ?? '',
      /^s-lockfile-committed: npm install --package-lock-only exited/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adopt gaps: an npm repository with neither workflow nor lockfile ends with no lane task for them', () => {
  const root = repo({
    'package.json':
      '{"name":"gap","version":"1.0.0","scripts":{"test":"node --test"}}\n',
  });
  mkdirSync(join(root, 'tasks'));
  try {
    const gaps = adoptionGaps(root, '2026-11-15');
    assert.deepEqual(gaps.remediated, [
      'package-lock.json',
      '.github/workflows/ci.yml',
    ]);
    assert.ok(
      !gaps.lines.some((line) =>
        /s-ci-runs-tests|s-lockfile-committed/u.test(line),
      ),
      gaps.lines.join('\n'),
    );
    assert.ok(
      !gaps.tasks.some((title) =>
        /s-ci-runs-tests|s-lockfile-committed/u.test(title),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refused workflow push opens one decision row, however many times it is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'krn-decide-once-'));
  try {
    const fields = {
      question: 'q',
      recommendation: 'r',
      default: 'd',
      deadline: '2026-11-22',
    };
    const first = openDecisionOnce(root, fields, '2026-11-15');
    const second = openDecisionOnce(root, fields, '2026-11-16');
    assert.equal(first.id, second.id);
    assert.equal(
      listDecisions(root, { today: '2026-11-16' }).split('\n  q\n').length,
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vacuous contract gets a workflow that runs the stack test command, not the placeholder, so no workflow task is left', () => {
  // krn.json exactly as adopt wrote it for the vacuous npm base in the outside acceptance run.
  const root = repo({
    'package.json': '{"name":"vac","version":"1.0.0"}\n',
    'package-lock.json': '{}\n',
    'krn.json': `${JSON.stringify(
      {
        base: 'outside/npm',
        test: "echo 'no test command: add one real test and set test in krn.json' >&2; exit 1",
        tracker: 'krn',
        vacuous: true,
      },
      null,
      2,
    )}\n`,
  });
  mkdirSync(join(root, 'tasks'));
  try {
    const gaps = adoptionGaps(root, '2026-11-15');
    assert.ok(gaps.remediated.includes('.github/workflows/ci.yml'));
    const text = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    assert.doesNotMatch(text, /no test command/u);
    assert.match(text, /npm ci && npm test/u);
    assert.ok(
      !gaps.tasks.some((title) => /s-ci-runs-tests/u.test(title)),
      gaps.tasks.join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
