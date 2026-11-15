import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  briefPaths,
  callSiteSweep,
  PRECEDENT_BUDGET,
  precedentSection,
} from '../../src/brain/precedent.ts';

function git(repo: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: repo, stdio: 'ignore' },
  );
}

function commit(repo: string, files: Record<string, string>, message: string) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
}

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'precedent-'));
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, { 'src/a.ts': 'export const a = 1;\n' }, 'feat: a');
  commit(
    repo,
    {
      'src/a.ts': 'export const a = 2;\n',
      'test/a.test.ts':
        "import { a } from '../src/a.ts';\nassert.equal(code, 64);\n",
    },
    'fix: a exits 64',
  );
  git(repo, 'checkout', '-q', '-b', 'side');
  commit(
    repo,
    {
      'src/a.ts': 'export const a = 3;\n',
      'test/a.test.ts': 'assert.equal(code, 99);\n',
    },
    'wip: unmerged a',
  );
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

test('brief paths come from the Scope line and backticked interface lines', () => {
  const brief =
    'Scope: src/a.ts, test/a.test.ts\n- `src/b.ts` exports `x`, `y`\nnot `src/c.ts`';
  assert.deepEqual(briefPaths(brief), ['src/a.ts', 'src/b.ts']);
});

test('the precedent lists HEAD commits, test hunks and importers, never an unmerged commit', () => {
  const repo = fixture();
  try {
    const text = precedentSection(repo, 'Scope: src/a.ts\n');
    assert.match(text, /fix: a exits 64/u);
    assert.match(text, /feat: a/u);
    assert.match(text, /\+assert\.equal\(code, 64\);/u);
    assert.match(text, /tests importing it: `test\/a\.test\.ts`/u);
    assert.doesNotMatch(text, /unmerged|code, 99/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the precedent respects the budget and a brief without paths gets none', () => {
  const repo = fixture();
  try {
    const small = precedentSection(repo, 'Scope: src/a.ts\n', 200);
    assert.ok(small.length <= 200);
    assert.ok(PRECEDENT_BUDGET >= small.length);
    assert.equal(precedentSection(repo, 'no paths here'), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function stackFixture(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'precedent-stack-'));
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, files, 'feat: initial');
  return repo;
}

test('a goal without a Scope line names the sibling test and helper in a PHP repo', () => {
  const repo = stackFixture({
    'src/Billing/InvoiceService.php': '<?php class InvoiceService {}\n',
    'tests/Billing/InvoiceServiceTest.php':
      '<?php class InvoiceServiceTest { use MakesInvoices; }\n',
    'tests/Support/MakesInvoices.php': '<?php trait MakesInvoices {}\n',
    'src/Other/Mailer.php': '<?php class Mailer {}\n',
  });
  try {
    const text = precedentSection(
      repo,
      'Goal: InvoiceService must round totals up to whole cents.',
    );
    assert.match(
      text,
      /Sibling tests:\n- `tests\/Billing\/InvoiceServiceTest\.php`/u,
    );
    assert.match(text, /`src\/Billing\/InvoiceService\.php`/u);
    assert.doesNotMatch(text, /Mailer/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a goal without a Scope line names the sibling test in an npm repo', () => {
  const repo = stackFixture({
    'package.json': '{}\n',
    'src/cart/totals.js': 'export function cartTotal() {}\n',
    'test/cart/totals.test.js':
      "import { cartTotal } from '../../src/cart/totals.js';\n",
  });
  try {
    const text = precedentSection(
      repo,
      'Fix `cartTotal` so it ignores empty lines.',
    );
    assert.match(text, /`test\/cart\/totals\.test\.js`/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('siblings are found in py, go and rs layouts and an unrelated goal yields nothing', () => {
  const repo = stackFixture({
    'app/ledger.py': 'def post_entry(): pass\n',
    'tests/test_ledger.py': 'from app.ledger import post_entry\n',
    'pkg/queue.go': 'package pkg\nfunc DrainQueue() {}\n',
    'pkg/queue_test.go':
      'package pkg\nfunc TestDrainQueue() { DrainQueue() }\n',
    'src/shard.rs': 'pub fn split_shard() {}\n',
    'tests/shard.rs': 'use x::split_shard;\n',
  });
  try {
    assert.match(
      precedentSection(repo, 'Goal: post_entry rejects negatives'),
      /`tests\/test_ledger\.py`/u,
    );
    assert.match(
      precedentSection(repo, 'Goal: DrainQueue must stop early'),
      /`pkg\/queue_test\.go`/u,
    );
    assert.match(
      precedentSection(repo, 'Goal: split_shard handles zero'),
      /`tests\/shard\.rs`/u,
    );
    assert.equal(precedentSection(repo, 'Goal: zzqxunknown thing'), '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('clause 6: a bug brief gets one sibling call site per source file that holds the defect pattern, tests excluded', () => {
  const repo = stackFixture({
    'src/orders/total.py': 'def roundTotal(x):\n    return int(x)\n',
    'src/invoices/total.py':
      'from orders.total import roundTotal\nroundTotal(1)\n',
    'src/other/mailer.py': 'def send():\n    pass\n',
    'tests/test_total.py': 'from orders.total import roundTotal\n',
  });
  try {
    const sweep = callSiteSweep(
      repo,
      'Bug: roundTotal truncates instead of rounding up.',
    );
    assert.equal(sweep.length, 2);
    assert.match(
      sweep[0] as string,
      /^Sibling call site src\/(?:invoices|orders)\/total\.py:\d+/u,
    );
    assert.ok(sweep.some((line) => line.includes('src/invoices/total.py')));
    assert.ok(!sweep.some((line) => line.includes('tests/')));
    assert.ok(!sweep.some((line) => line.includes('mailer')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
