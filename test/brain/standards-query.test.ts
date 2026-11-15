import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { EXPOSURES_FILE, readExposures } from '../../src/brain/exposures.ts';
import { heldOut, QUERY_TASK } from '../../src/brain/worker-packet.ts';
import { commandHelp } from '../../src/cli/help.ts';

const krn = join(import.meta.dirname, '../../bin/krn');

function record(id: string, text: string, why: string, applies: object) {
  return {
    id,
    type: 'standard',
    text,
    why,
    audience: 'worker',
    tier: 'reflex',
    applies: { stacks: [], needs: [], paths: [], terms: [], ...applies },
    enforcement: { kind: 'advisory' },
    provenance: { origin: 'test', evidence: ['test'], proposals: [] },
    status: 'accepted',
    recorded_at: '2026-11-01',
    valid_from: '2026-11-01',
    valid_to: null,
    supersedes: [],
  };
}

/** A git repository with one manifest file and the given project records. */
function fixture(files: Record<string, string>, records: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'krn-query-'));
  spawnSync('git', ['-C', root, 'init', '-q']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(
    join(root, '.agents/standards.json'),
    JSON.stringify(records, null, 2),
  );
  return root;
}

function query(root: string, ...args: string[]) {
  return spawnSync(krn, ['standards', 'query', ...args, '--root', root], {
    encoding: 'utf8',
  });
}

const planted = [
  record(
    'p-rest-permission',
    'A REST endpoint registers a permission callback and sanitizes every request argument.',
    'An open route exposes data to anyone.',
    { stacks: ['php'] },
  ),
  record(
    'p-async-handler',
    'An async handler awaits every promise and turns a rejection into a response error.',
    'A floating promise loses the failure.',
    { stacks: ['node'] },
  ),
  record(
    'p-wp-template',
    'A WordPress template part escapes every printed value with esc_html or esc_attr.',
    'Unescaped output is stored cross-site scripting.',
    { needs: ['wordpress'], paths: ['**/*.php'] },
  ),
  record(
    'p-go-context',
    'A Go handler passes the request context to every call.',
    'Cancellation reaches the call.',
    { stacks: ['go'] },
  ),
];

test('the planted records are outside the query holdout', () => {
  for (const { id } of planted) assert.equal(heldOut(QUERY_TASK, id), false);
});

const cases = [
  {
    name: 'a PHP REST endpoint',
    files: { 'composer.json': '{"require":{"php":">=8.1"}}' },
    text: 'add a REST endpoint that returns posts as JSON',
    args: ['--file', 'src/Rest/PostsController.php'],
    want: 'p-rest-permission',
  },
  {
    name: 'a TS async handler',
    files: {
      'package.json':
        '{"name":"x","type":"module","scripts":{"test":"node --test"}}',
    },
    text: 'write an async handler that awaits the database and returns a response',
    args: ['--file', 'src/handler.ts'],
    want: 'p-async-handler',
  },
  {
    name: 'a WP template',
    files: {
      'composer.json': '{"require":{"roots/bedrock":"*"}}',
      'web/app/themes/x/style.css': '/*\nTheme Name: X\n*/',
    },
    text: 'edit the template part to print the post title and excerpt',
    args: ['--file', 'web/app/themes/x/parts/card.php'],
    want: 'p-wp-template',
  },
];

for (const c of cases) {
  test(`query for ${c.name} ranks the planted record in the top 3, within the budget, and logs a query exposure`, () => {
    const root = fixture(c.files, planted);
    try {
      const json = query(root, c.text, ...c.args, '--budget', '300', '--json');
      assert.equal(json.status, 0, json.stderr);
      const hits = JSON.parse(json.stdout) as { id: string; text: string }[];
      assert.ok(
        hits.slice(0, 3).some((hit) => hit.id === c.want),
        hits.map((hit) => hit.id).join(),
      );
      assert.ok(!hits.some((hit) => hit.id === 'p-go-context'));
      const plain = query(root, c.text, ...c.args, '--budget', '300');
      assert.equal(plain.status, 0, plain.stderr);
      assert.ok(plain.stdout.includes(`[${c.want}]`));
      assert.ok(plain.stdout.includes('(why: '));
      assert.ok(Math.ceil(plain.stdout.trimEnd().length / 4) <= 300);
      const rows = readExposures(root).filter((e) => e.channel === 'query');
      assert.equal(rows.length, 2);
      assert.ok(rows[0]?.served.includes(c.want));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a small --budget keeps the answer within it, down to nothing', () => {
  const root = fixture(cases[0]?.files ?? {}, planted);
  try {
    const out = query(root, cases[0]?.text ?? '', '--budget', '30');
    assert.equal(out.status, 0, out.stderr);
    assert.ok(
      Math.ceil(out.stdout.trimEnd().length / 4) <= 30 ||
        out.stdout.trim() === 'no matching record',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no matching record prints the plain line, exits 0 and logs nothing', () => {
  const root = fixture({ 'package.json': '{"name":"x"}' }, planted);
  try {
    const out = query(root, 'zzqx plugh');
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, 'no matching record\n');
    assert.throws(() => readFileSync(join(root, EXPOSURES_FILE)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a held-out record is never shown for its task', () => {
  const root = fixture({ 'composer.json': '{}' }, planted);
  try {
    const id = 'p-rest-permission';
    const task = Array.from({ length: 200 }, (_, n) => `t-${n}`).find((t) =>
      heldOut(t, id),
    );
    assert.ok(task !== undefined);
    const out = query(
      root,
      'REST endpoint permission callback',
      '--task',
      task,
      '--json',
    );
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!out.stdout.includes(id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clause 16: the standards help names the query verb', () => {
  assert.match(
    commandHelp(['standards', '--help']) ?? '',
    /query TEXT \[--file PATH\]/,
  );
});
