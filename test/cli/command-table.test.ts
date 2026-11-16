import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  commandHelp,
  commandLines,
  isCommand,
  topLevelHelp,
} from '../../src/cli/help.ts';
import { dispatch } from '../../src/cli/index.ts';
import { parseContractFile } from '../../src/repo/contract.ts';

test('the router and the help text share one command list', async () => {
  assert.equal(isCommand('lane'), true);
  assert.equal(isCommand('review'), false);
  assert.equal(isCommand('toString'), false);
  assert.ok(commandLines().length >= 12);
  assert.equal(await dispatch(['nope']), false);
});

const root = new URL('../../', import.meta.url);
const commandNames = commandLines().map((line) => line.split(' ')[1] ?? '');

test('every command has a help row that opens with its own name', () => {
  assert.equal(new Set(commandNames).size, commandNames.length);
  for (const name of commandNames) {
    assert.equal(isCommand(name), true, name);
    // `task` prints its own richer help.
    if (name !== 'task')
      assert.match(commandHelp([name, '--help']) ?? '', /^Usage: krn /u);
  }
  assert.match(topLevelHelp(), /krn task/u);
  for (const name of commandNames)
    assert.ok(topLevelHelp().includes(`krn ${name}`), name);
});

test('README and CONTEXT name every command and every krn.json field', () => {
  let fields: string[] = [];
  try {
    parseContractFile('{"nope":1}');
  } catch (error) {
    fields =
      /fields: ([^)]*)\)/u.exec((error as Error).message)?.[1]?.split(', ') ??
      [];
  }
  assert.ok(fields.length >= 10);
  for (const file of ['README.md', 'CONTEXT.md']) {
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const name of [...commandNames, ...fields])
      assert.ok(text.includes(`\`${name}\``), `${file} lacks \`${name}\``);
  }
});

test('the lane usage header names every verb the lane command dispatches', () => {
  const source = readFileSync(new URL('src/cli/lane.ts', root), 'utf8');
  const verbs = [...source.matchAll(/verb === '([a-z]+)'/gu)].map((m) => m[1]);
  const header = (commandHelp(['lane', '--help']) ?? '').split('  ')[0] ?? '';
  for (const verb of new Set(verbs))
    assert.match(header, new RegExp(`\\b${verb}\\b`, 'u'), verb);
});
