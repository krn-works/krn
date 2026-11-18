import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hcHost } from '../../src/successor/host-hc.ts';
import { herdrHost } from '../../src/successor/host-herdr.ts';
import { unsentInput } from '../../src/successor/unsent-input.ts';

const screens = new URL('../fixtures/herdr/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, screens), 'utf8');
const empty = read('pane-read-empty-prompt.txt');
const typed = read('pane-read-unsent-input.txt');

test('a prompt box holding text is unsent input', () => {
  assert.equal(unsentInput(typed), true);
  assert.equal(unsentInput('─\n❯ x\n─\n'), true);
});

test('an empty prompt box with its no-break space holds nothing', () => {
  assert.equal(unsentInput(empty), false);
  assert.equal(unsentInput('─\n❯ \n─\n'), false);
});

test('the last prompt box decides and a screen without one holds nothing', () => {
  assert.equal(unsentInput(`${typed}\n${empty}`), false);
  assert.equal(unsentInput(`${empty}\n${typed}`), true);
  assert.equal(unsentInput(''), false);
  assert.equal(unsentInput('plain shell output\n'), false);
});

test('a host without its CLI cannot read a screen', () => {
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    assert.equal(herdrHost({}).screen(herdrHost({}).session('p1')), undefined);
    assert.equal(hcHost({}).screen(hcHost({}).session('t1')), undefined);
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});
