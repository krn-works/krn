import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appCredentialArgs,
  outsideCredentialArgs,
  outsideGit,
  repositoryOfRemote,
} from '../../src/cli/outside-git.ts';

test('a remote URL names its owner/name in every GitHub form', () => {
  for (const url of [
    'https://github.com/krn-works/seo-audit-harness.git',
    'https://github.com/krn-works/seo-audit-harness',
    'https://x-access-token@github.com/krn-works/seo-audit-harness.git',
    'git@github.com:krn-works/seo-audit-harness.git',
    'ssh://git@github.com/krn-works/seo-audit-harness.git',
  ])
    assert.equal(repositoryOfRemote(url), 'krn-works/seo-audit-harness', url);
  assert.equal(repositoryOfRemote('https://example.com/a/b.git'), undefined);
  assert.equal(repositoryOfRemote('/srv/git/a.git'), undefined);
});

test('the credential helper names the repository and carries no token', () => {
  const args = appCredentialArgs('krn-works/seo-audit-harness', '/n/node');
  assert.equal(args[1], 'credential.https://github.com.helper=');
  assert.match(
    args[3] ?? '',
    /^credential\.https:\/\/github\.com\.helper=!KRN_APP_REPOSITORY='krn-works\/seo-audit-harness' '\/n\/node' '.*github-app-token\.ts' git-credential$/u,
  );
});

test('git against an outside GitHub origin runs under that repository helper, not the default credential', () => {
  const calls: string[][] = [];
  const run = ((_c: string, a: string[]) => {
    calls.push(a);
    return a.includes('get-url')
      ? {
          status: 0,
          stdout: 'https://github.com/krn-works/seo-audit-harness.git\n',
          stderr: '',
        }
      : { status: 0, stdout: 'ok\n', stderr: '' };
  }) as unknown as Parameters<typeof outsideGit>[2];
  assert.equal(outsideGit('/src/x', ['fetch', '-q', 'origin'], run), 'ok');
  const fetch = calls[1] ?? [];
  assert.ok(
    fetch.some((a) =>
      a.includes("KRN_APP_REPOSITORY='krn-works/seo-audit-harness'"),
    ),
  );
  assert.deepEqual(fetch.slice(-5), ['-C', '/src/x', 'fetch', '-q', 'origin']);
});

test('a non-GitHub origin runs plain git and a failure names the command', () => {
  const calls: string[][] = [];
  const run = ((_c: string, a: string[]) => {
    calls.push(a);
    return a.includes('get-url')
      ? { status: 0, stdout: '/srv/a.git\n', stderr: '' }
      : { status: 1, stdout: '', stderr: 'boom\n' };
  }) as unknown as Parameters<typeof outsideGit>[2];
  assert.throws(
    () => outsideGit('/s', ['fetch'], run),
    /git fetch failed: boom/u,
  );
  assert.deepEqual(calls[1], ['-C', '/s', 'fetch']);
});

test('real git accepts the helper arguments and reports them for an outside origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outside-git-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', [
    '-C',
    dir,
    'remote',
    'add',
    'origin',
    'https://github.com/krn-works/seo-audit-harness.git',
  ]);
  const helpers = outsideGit(dir, [
    'config',
    '--get-all',
    'credential.https://github.com.helper',
  ]).split('\n');
  assert.match(
    helpers.at(-1) ?? '',
    /KRN_APP_REPOSITORY='krn-works\/seo-audit-harness'.*git-credential$/u,
  );
});

test('only an outside GitHub origin gets its App helper; the product origin keeps the default credential', () => {
  const origin = (url: string) =>
    (() => ({
      status: 0,
      stdout: `${url}\n`,
      stderr: '',
    })) as unknown as Parameters<typeof outsideCredentialArgs>[1];
  assert.deepEqual(
    outsideCredentialArgs('/r', origin('https://github.com/krn-works/krn.git')),
    [],
  );
  assert.deepEqual(outsideCredentialArgs('/r', origin('/srv/a.git')), []);
  assert.match(
    outsideCredentialArgs(
      '/r',
      origin('git@github.com:krn-works/seo-audit-harness.git'),
    )[3] ?? '',
    /KRN_APP_REPOSITORY='krn-works\/seo-audit-harness'/u,
  );
});
