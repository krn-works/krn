import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, 'utf8');
const settings = JSON.parse(read('.claude/settings.json')) as {
  permissions: { deny: string[] };
  hooks: Record<
    string,
    { matcher?: string; hooks: { command: string; timeout?: number }[] }[]
  >;
};
const groups = Object.values(settings.hooks).flat();

test('every project hook command has a timeout', () => {
  const missing = groups
    .flatMap((group) => group.hooks)
    .filter((hook) => typeof hook.timeout !== 'number')
    .map((hook) => hook.command);
  assert.deepEqual(missing, []);
});

test('hook commands run scripts that exist', () => {
  for (const group of groups)
    for (const hook of group.hooks) {
      const script = /\/((?:scripts|src)\/[\w/.-]+\.ts)/u.exec(hook.command);
      assert.ok(script?.[1], `no script in ${hook.command}`);
      read(script[1]);
    }
});

test('no denied tool appears in a hook matcher', () => {
  const denied = settings.permissions.deny.filter((rule) =>
    /^\w+$/u.test(rule),
  );
  for (const group of groups)
    for (const name of (group.matcher ?? '').split('|'))
      assert.ok(!denied.includes(name), `${name} is denied but in a matcher`);
});

test('read-only agents on untrusted content have no shell', () => {
  for (const name of ['krn-radar', 'krn-research']) {
    const tools = /^tools: (.*)$/mu.exec(read(`.claude/agents/${name}.md`));
    assert.ok(tools?.[1], `${name} lists its tools`);
    assert.ok(!/\b(Bash|Write|Edit)\b/u.test(tools[1]), `${name} has a shell`);
  }
});
