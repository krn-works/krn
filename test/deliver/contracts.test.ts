import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { redFirst } from '../../src/flow/repository.ts';
import { stateDirectory } from '../../src/foreman/state.ts';
import type { execute } from '../../src/verdict/sandbox.ts';

const api = await import('../../src/deliver/message.ts').catch(() => undefined);
const transport = await import('../../src/deliver/transport.ts').catch(
  () => undefined,
);

// Real Node assertions and existing redFirst classification, with only the
// containment transport replaced for these private, test-owned fixture trees.
const localExecute: typeof execute = async (
  _root,
  copy,
  job,
  id,
  argv,
  _timeout,
  sha,
) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const child = spawnSync(argv[0] ?? process.execPath, argv.slice(1), {
    cwd: copy,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  const output = `${child.stdout}${child.stderr}`;
  const diagnostics = join(stateDirectory(job), 'diagnostics');
  mkdirSync(diagnostics, { recursive: true });
  writeFileSync(
    join(diagnostics, `${sha}-${id}-capture.txt`),
    Buffer.from(output).subarray(-2048),
  );
  return {
    id,
    exitCode: child.status ?? 1,
    durationMs: 0,
    sha256: createHash('sha256').update(output).digest('hex'),
  };
};

for (const baseValue of [1, 2]) {
  test(`merge-level observer compares PR base value ${baseValue} with merged tree, using existing redFirst`, async (t) => {
    assert.equal(typeof api?.checkMergeContracts, 'function');
    assert.equal(typeof transport?.run, 'function');
    assert.ok(api && transport);
    const root = mkdtempSync(join(tmpdir(), 'krn-merge-contract-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const put = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const commit = (message: string) => {
      git(['add', '.']);
      git(['commit', '--quiet', '-m', message]);
      return git(['rev-parse', 'HEAD']);
    };
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.com']);
    put('.gitignore', '.krn/\n');
    put('package.json', '{"type":"module"}');
    put('src/value.mjs', `export const value = ${baseValue};\n`);
    const base = commit('base');
    // For base=2, the declaration is red against its own parent but green at
    // the actual PR base. A per-commit-only check would incorrectly allow it.
    if (baseValue === 2) {
      put('src/value.mjs', 'export const value = 1;\n');
      commit('intermediate');
    }
    put(
      'test/value.test.mjs',
      "import assert from 'node:assert/strict'; import test from 'node:test'; import {value} from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n",
    );
    put('src/value.mjs', 'export const value = 2;\n');
    const message =
      'feat: value\n\nTicket: t-value\nChange-contract: test/value.test.mjs:red->green\n';
    const head = commit(message);
    const evaluate: typeof redFirst = async (
      repo,
      requestedBase,
      requestedHead,
    ) => {
      assert.equal(requestedBase, base);
      const report = await redFirst(
        repo,
        requestedBase,
        requestedHead,
        undefined,
        localExecute,
      );
      assert.equal(report.contracts?.[0]?.red?.sha, base);
      assert.equal(report.contracts?.[0]?.green.classification, 'pass');
      assert.equal(
        report.contracts?.[0]?.red?.classification,
        baseValue === 1 ? 'assertion' : 'pass',
      );
      return report;
    };
    const pending = api.checkMergeContracts(
      root,
      base,
      head,
      message,
      transport.run,
      evaluate,
    );
    if (baseValue === 1) await pending;
    else await assert.rejects(pending, /PR base/u);
    await assert.rejects(
      api.checkMergeContracts(
        root,
        base,
        head,
        'feat: value\n\nTicket: t-value\nChange-contract: none (tracker only)\n',
        transport.run,
      ),
      /tracker-only/u,
    );
  });
}
