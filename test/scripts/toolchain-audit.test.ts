import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type AuditInput,
  audit,
  providesCommand,
  shortName,
  verdict,
} from '../../scripts/toolchain-audit.ts';

const clean: AuditInput = {
  installed: {
    node: [{ version: '26.13.1', active: true }],
    pnpm: [{ version: '12.21.0', active: true }],
  },
  outdated: [],
  filePins: [{ file: 'a/.node-version', tool: 'node', version: '26.13.1' }],
  latest: { node: '26.13.1' },
  pathHits: {},
  tempConfigs: [],
  foreignInstalls: [],
  unprovided: [],
  errors: [],
};

test('a host with one current version per tool passes', () => {
  const findings = audit(clean);
  assert.deepEqual(findings, []);
  assert.equal(verdict(findings), 'toolchain PASS');
});

test('each kind of divergence is one finding and the verdict counts them', () => {
  const findings = audit({
    installed: {
      node: [{ version: '24.22.1' }, { version: '26.13.1', active: true }],
      playwright: [{ version: '1.65.1', active: true }],
      'npm:playwright': [{ version: '1.63.0' }],
      'npm:@excalidraw/cli': [{ version: '1.0.0' }],
      'npm:@unlighthouse/cli': [{ version: '0.19.1' }],
    },
    outdated: [
      {
        tool: 'go',
        current: '1.26.0',
        latest: '1.27.4',
        source: 'p/mise.toml',
      },
    ],
    filePins: [
      {
        file: 'p/package.json packageManager',
        tool: 'pnpm',
        version: '12.5.1',
      },
    ],
    latest: { pnpm: '12.21.0' },
    pathHits: { pnpm: ['/usr/bin/pnpm'] },
    tempConfigs: ['/tmp/x/mise.toml'],
    foreignInstalls: ['github-composer-composer/2.10.3 -> /usr'],
    unprovided: [],
    errors: ['q: mise.toml is not trusted'],
  });
  assert.deepEqual(
    findings.map((f) => f.line),
    [
      'outdated p/mise.toml go 1.26.0 -> 1.27.4',
      'outdated p/package.json packageManager pnpm 12.5.1 -> 12.21.0',
      'multi node 24.22.1 26.13.1 (active 26.13.1)',
      'backend playwright installed as npm:playwright, playwright',
      'path pnpm also outside mise: /usr/bin/pnpm',
      'tracking 1 temporary configs keep versions from mise prune (e.g. /tmp/x/mise.toml)',
      'foreign github-composer-composer/2.10.3 -> /usr',
      'error q: mise.toml is not trusted',
    ],
  );
  assert.equal(
    verdict(findings),
    'toolchain FAIL (2 outdated, 1 multi, 1 backend, 1 path, 1 tracking, 1 foreign, 1 error)',
  );
});

test('the backend prefix and owner drop, a scoped npm name stays whole', () => {
  assert.equal(shortName('aqua:carthage-software/mago'), 'mago');
  assert.equal(shortName('npm:playwright'), 'playwright');
  assert.equal(shortName('npm:@excalidraw/cli'), '@excalidraw/cli');
  assert.equal(shortName('node'), 'node');
});

test('a pin whose install holds only composer.phar yields a provides finding naming config and fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provides-'));
  writeFileSync(join(dir, 'composer.phar'), '');
  chmodSync(join(dir, 'composer.phar'), 0o755);
  assert.equal(providesCommand(dir, 'composer'), false);
  const findings = audit({
    ...clean,
    unprovided: [{ tool: 'github:composer/composer', config: 'p/mise.toml' }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, 'provides');
  assert.match(findings[0]?.line ?? '', /p\/mise\.toml/u);
  assert.match(findings[0]?.line ?? '', /bin = "composer"/u);
});

test('a pin whose install holds a composer executable yields no provides finding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provides-'));
  writeFileSync(join(dir, 'composer'), '');
  chmodSync(join(dir, 'composer'), 0o755);
  assert.equal(providesCommand(dir, 'composer'), true);
  assert.deepEqual(audit(clean), []);
});
