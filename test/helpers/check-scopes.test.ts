import assert from 'node:assert/strict';
import { test } from 'node:test';

const probe = 'http://127.0.0.1:41234/probe';

function fakeHost() {
  const groups: Record<string, string> = {
    'krn-check-foreign.scope': '/user/foreign',
    'krn-check-owned.scope': '/user/owned',
    'krn-check-drained.scope': '/user/drained',
  };
  const files: Record<string, string> = {
    '/user/foreign/cgroup.events': 'populated 1\nfrozen 0\n',
    '/user/foreign/cgroup.procs': '101\n',
    '/user/owned/cgroup.events': 'populated 1\nfrozen 0\n',
    '/user/owned/cgroup.procs': '201\n202\n',
    '/user/drained/cgroup.events': 'populated 0\nfrozen 0\n',
    '/user/drained/cgroup.procs': '',
  };
  const cmdlines: Record<string, string> = {
    '101': 'node\0--test\0other.test.ts\0',
    '202': `node\0-e\0fetch(${JSON.stringify(probe)})\0`,
  };
  return {
    listScopes: () => [
      ...Object.keys(groups).map((unit) => ({ unit, active: 'active' })),
      { unit: 'krn-check-inactive.scope', active: 'inactive' },
      { unit: 'session-1.scope', active: 'active' },
    ],
    controlGroup: (unit: string) => groups[unit] ?? '',
    readCgroup: (cgroup: string, file: string) => {
      const content = files[`${cgroup}/${file}`];
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    cmdline: (pid: string) => {
      const content = cmdlines[pid];
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
  };
}

async function load(): Promise<Record<string, unknown> | undefined> {
  try {
    return await import('./check-scopes.ts');
  } catch {
    return undefined;
  }
}

test('owned scope discovery ignores populated krn-check scopes of other shards', async () => {
  const module = await load();
  assert.equal(typeof module?.populatedCheckScopes, 'function');
  const discover = module?.populatedCheckScopes as (
    host: ReturnType<typeof fakeHost>,
    owner?: string,
  ) => Set<string>;
  assert.deepEqual([...discover(fakeHost(), probe)], ['krn-check-owned.scope']);
  assert.deepEqual([...discover(fakeHost())].sort(), [
    'krn-check-foreign.scope',
    'krn-check-owned.scope',
  ]);
});

test('owned scope discovery reports nothing once the owned probe has drained', async () => {
  const module = await load();
  assert.equal(typeof module?.populatedCheckScopes, 'function');
  const discover = module?.populatedCheckScopes as (
    host: ReturnType<typeof fakeHost>,
    owner?: string,
  ) => Set<string>;
  assert.deepEqual([...discover(fakeHost(), 'http://127.0.0.1:1/none')], []);
});
