import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const names = [
  'LocalReadError',
  'openVerifiedDirectory',
  'openVerifiedFile',
  'readBoundedFile',
  'listVerifiedDirectory',
  'lstatVerified',
  'lstatVerifiedIfPresent',
] as const;
type Api = typeof import('../../src/fs/local-read.ts');
async function load(): Promise<Api> {
  // A missing module must fail by assertion, not by import error.
  const api: Record<string, unknown> = await import(
    '../../src/fs/local-read.ts'
  ).catch(() => ({}));
  for (const name of names)
    assert.equal(typeof api[name], 'function', `${name} exported`);
  return api as unknown as Api;
}
function root(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function reason(
  api: Awaited<ReturnType<typeof load>>,
  action: () => unknown,
  expected: string,
) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof api.LocalReadError && error.reason === expected,
  );
}
function fdCount() {
  return readdirSync('/proc/self/fd').length;
}

test('final component symlinks are unsafe for file and directory opens', async () => {
  const api = await load();
  const dir = root('local-read-link-');
  try {
    mkdirSync(join(dir, 'target'));
    writeFileSync(join(dir, 'target', 'f'), 'x');
    symlinkSync(join(dir, 'target', 'f'), join(dir, 'file-link'));
    symlinkSync(join(dir, 'target'), join(dir, 'dir-link'));
    reason(
      api,
      () => api.openVerifiedFile(join(dir, 'file-link'), 2),
      'unsafe',
    );
    reason(
      api,
      () => api.openVerifiedDirectory(join(dir, 'dir-link')),
      'unsafe',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlinked ancestors are unsafe for every helper', async () => {
  const api = await load();
  const dir = root('local-read-ancestor-');
  try {
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'f'), 'x');
    symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    for (let i = 0; i < 4; i++) {
      const before = fdCount();
      if (i === 0)
        reason(
          api,
          () => api.openVerifiedFile(join(dir, 'alias', 'f'), 2),
          'unsafe',
        );
      if (i === 1)
        reason(
          api,
          () => api.openVerifiedDirectory(join(dir, 'alias')),
          'unsafe',
        );
      if (i === 2)
        reason(api, () => api.lstatVerified(join(dir, 'alias', 'f')), 'unsafe');
      if (i === 3)
        reason(
          api,
          () => api.lstatVerifiedIfPresent(join(dir, 'alias', 'f')),
          'unsafe',
        );
      assert.equal(fdCount(), before);
    }
    // An absent target under a symlinked ancestor is unsafe too.
    reason(api, () => api.lstatVerified(join(dir, 'alias', 'none')), 'unsafe');
    reason(
      api,
      () => api.lstatVerifiedIfPresent(join(dir, 'alias', 'none')),
      'unsafe',
    );
    // A dangling symlinked ancestor is unsafe, not missing.
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
    reason(
      api,
      () => api.lstatVerified(join(dir, 'dangling', 'none')),
      'unsafe',
    );
    reason(
      api,
      () => api.lstatVerifiedIfPresent(join(dir, 'dangling', 'none')),
      'unsafe',
    );
    // A genuinely absent ancestor stays missing.
    reason(api, () => api.lstatVerified(join(dir, 'gone', 'none')), 'missing');
    assert.equal(
      api.lstatVerifiedIfPresent(join(dir, 'gone', 'none')),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing file reports missing on open and absent lstat returns undefined', async () => {
  const api = await load();
  const dir = root('local-read-missing-');
  try {
    const path = join(dir, 'missing');
    const before = fdCount();
    reason(api, () => api.openVerifiedFile(path, 2), 'missing');
    assert.equal(fdCount(), before);
    assert.equal(api.lstatVerifiedIfPresent(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('directories and FIFOs are unsafe files without blocking', async () => {
  const api = await load();
  const dir = root('local-read-types-');
  const fifo = join(dir, 'fifo');
  try {
    mkdirSync(join(dir, 'sub'));
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    for (const path of [join(dir, 'sub'), fifo]) {
      const before = fdCount();
      reason(api, () => api.openVerifiedFile(path, 20), 'unsafe');
      assert.equal(fdCount(), before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bounded reads accept limit and reject limit plus one', async () => {
  const api = await load();
  const dir = root('local-read-bounds-');
  try {
    const path = join(dir, 'f');
    writeFileSync(path, '1234');
    assert.equal(api.readBoundedFile(path, 4).toString(), '1234');
    const before = fdCount();
    reason(api, () => api.readBoundedFile(path, 3), 'oversized');
    assert.equal(fdCount(), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('directory listing is sorted at limit and rejects limit plus one', async () => {
  const api = await load();
  const dir = root('local-read-list-');
  try {
    writeFileSync(join(dir, 'b'), '');
    writeFileSync(join(dir, 'a'), '');
    const fd = api.openVerifiedDirectory(dir);
    try {
      assert.deepEqual(
        api.listVerifiedDirectory(fd, 2).map((x) => x.name),
        ['a', 'b'],
      );
      const before = fdCount();
      reason(api, () => api.listVerifiedDirectory(fd, 1), 'entry-limit');
      assert.equal(fdCount(), before);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listing an opened directory survives a path swap', async () => {
  const api = await load();
  const dir = root('local-read-swap-');
  const original = join(dir, 'original');
  const replacement = join(dir, 'replacement');
  mkdirSync(original);
  mkdirSync(replacement);
  writeFileSync(join(original, 'original-entry'), '');
  writeFileSync(join(replacement, 'replacement-entry'), '');
  try {
    const fd = api.openVerifiedDirectory(original);
    try {
      renameSync(original, join(dir, 'moved'));
      symlinkSync(replacement, original, 'dir');
      assert.deepEqual(
        api.listVerifiedDirectory(fd, 10).map((e) => e.name),
        ['original-entry'],
      );
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
