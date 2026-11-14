import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  REQUIRED_CHECK_APP_ID,
  REQUIRED_CHECK_NAME,
} from '../../src/repo/ci-admission-contract.ts';

const root = new URL('../../', import.meta.url).pathname;
const owner = join('src', 'repo', 'ci-admission-contract.ts');

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

test('the constants resolve from spec/ci-admission.json', () => {
  const spec = JSON.parse(
    readFileSync(join(root, 'spec/ci-admission.json'), 'utf8'),
  ) as { checkRunName: string; appId: number };
  assert.equal(REQUIRED_CHECK_NAME, spec.checkRunName);
  assert.equal(REQUIRED_CHECK_APP_ID, spec.appId);
});

test('no source repeats the required check App id or check name literal', () => {
  const offenders = sources('src')
    .filter((file) => file !== owner)
    .filter((file) => {
      const code = readFileSync(join(root, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
      return (
        code.includes(String(REQUIRED_CHECK_APP_ID)) ||
        new RegExp(`['"\`]${REQUIRED_CHECK_NAME}['"\`]`, 'u').test(code)
      );
    });
  assert.deepEqual(offenders, []);
});
