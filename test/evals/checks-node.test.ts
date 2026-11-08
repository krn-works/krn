import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, refusal } from './checks-fixture.ts';

test('eval check reports missing and mismatched Node installations as data errors', async () => {
  const f = await fixture();
  try {
    f.task.node = '0.0.0';
    await f.save();
    refusal(f.run(), 65, /[Nn]ode.*0\.0\.0/u);
    const fake = join(f.directory, 'mise');
    const bin = join(fake, 'installs/node/0.0.0/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'node'), '#!/bin/sh\nprintf "v1.2.3\\n"\n', {
      mode: 0o755,
    });
    refusal(
      f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: fake }),
      65,
      /version|0\.0\.0/u,
    );
    await chmod(join(bin, 'node'), 0o644);
    refusal(
      f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: fake }),
      65,
      /[Nn]ode/u,
    );
  } finally {
    await f.cleanup();
  }
});

test('eval check rejects Node tool paths through symlinks or candidate areas before executing them', async () => {
  const f = await fixture();
  try {
    const install = join(f.directory, 'mise');
    const bin = join(install, 'installs/node', f.task.node, 'bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'node');
    await writeFile(
      executable,
      `#!/bin/sh\ntouch "$0.started"\nprintf 'v${f.task.node}\\n'\n`,
      { mode: 0o755 },
    );
    const link = join(f.directory, 'mise-link');
    await symlink(install, link);
    for (const data of [link, `${link}/../mise`])
      refusal(
        f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: data }),
        65,
        /symlink/u,
      );
    for (const area of [f.slot, f.experiment]) {
      const nodeBin = join(area, 'installs/node', f.task.node, 'bin');
      await mkdir(nodeBin, { recursive: true });
      await writeFile(join(nodeBin, 'node'), await readFile(executable), {
        mode: 0o755,
      });
      refusal(
        f.invoke(f.args(), { ...f.env, MISE_DATA_DIR: area }),
        65,
        /overlap/u,
      );
      await assert.rejects(access(join(nodeBin, 'node.started')), {
        code: 'ENOENT',
      });
    }
    await assert.rejects(access(`${executable}.started`), { code: 'ENOENT' });
  } finally {
    await f.cleanup();
  }
});
