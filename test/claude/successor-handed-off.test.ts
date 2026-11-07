import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const api = await import('../../scripts/claude/successor-launch.ts');
let ledgerRoot = '';
function retire(
  args: string[],
  pause?: (seconds: number) => void,
  now?: () => number,
): number {
  assert.equal(
    typeof api.retireMode,
    'function',
    'base must expose --retire implementation',
  );
  return api.retireMode([...args, '--cwd', ledgerRoot], pause, now);
}

function setup(
  t: { after(fn: () => void): void },
  opts: Record<string, unknown> = {},
) {
  const previousEnv = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'handed-tabs-'));
  ledgerRoot = root;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls.jsonl');
  const program = `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nconst a=process.argv.slice(2);if(process.env.FAIL_PANE==='1'&&a[0]==='pane')process.exit(1);if(process.env.FAIL_CLOSE==='1'&&a[1]==='close')process.exit(1);const prior=(()=>{try{return readFileSync(process.env.CALLS,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}catch{return []}})();appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');\nlet r={};\nif(a[0]==='pane'&&a[1]==='get')r={result:{pane:{workspace_id:'w1',tab_id:'own'}}};\nelse if(a[0]==='agent'&&a[1]==='get'){const all=JSON.parse(process.env.AGENTS);const n=prior.filter(x=>x[0]==='agent'&&x[2]===a[2]).length;r=all[a[2]]?.[Math.min(n,all[a[2]].length-1)]||{result:{agent:{agent:'claude',agent_status:'idle',agent_session:{value:'session'},tab_id:'t'}}};}\nelse if(a[0]==='tab'&&a[1]==='list')r={result:{tabs:JSON.parse(process.env.TABS)}};\nprocess.stdout.write(JSON.stringify(r)+'\\n');`;
  const executable = join(bin, 'herdr');
  writeFileSync(executable, program);
  chmodSync(executable, 0o755);
  for (const key of Object.keys(process.env))
    if (key.startsWith('HERDR_') || key.startsWith('KRN_PREDECESSOR_'))
      delete process.env[key];
  Object.assign(process.env, {
    PATH: `${bin}:${previousEnv.PATH}`,
    CALLS: calls,
    HERDR_PANE_ID: 'self',
    TABS: '[]',
    AGENTS: '{}',
    ...opts,
  });
  return { calls, root };
}
function calls(path: string): string[][] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function agent(status: string, session = 'session') {
  return {
    result: {
      agent: {
        agent: 'claude',
        agent_status: status,
        agent_session: { value: session },
        tab_id: 't',
      },
    },
  };
}
function tabs() {
  return [
    {
      tab_id: 'idle',
      workspace_id: 'w1',
      label: 'handed off → old',
      agent_status: 'idle',
    },
    {
      tab_id: 'working',
      workspace_id: 'w1',
      label: 'handed off → live',
      agent_status: 'working',
    },
    {
      tab_id: 'ordinary',
      workspace_id: 'w1',
      label: 'ordinary',
      agent_status: 'idle',
    },
    {
      tab_id: 'other',
      workspace_id: 'w2',
      label: 'handed off → foreign',
      agent_status: 'idle',
    },
    {
      tab_id: 'own',
      workspace_id: 'w1',
      label: 'handed off → current',
      agent_status: 'idle',
    },
  ];
}

test('idle matching immediate predecessor and eligible handed-off tab close; other tabs stay', (t) => {
  const x = setup(t, {
    KRN_PREDECESSOR_PANE: 'pred',
    KRN_PREDECESSOR_SESSION: 'session',
    AGENTS: JSON.stringify({ pred: [agent('idle')] }),
    TABS: JSON.stringify(tabs()),
  });
  assert.equal(retire(['--wait-seconds', '0']), 0);
  const c = calls(x.calls);
  assert.ok(c.some((a) => a.join(' ') === 'pane close pred'));
  assert.ok(c.some((a) => a.join(' ') === 'tab close idle'));
  for (const id of ['working', 'ordinary', 'other', 'own'])
    assert.ok(!c.some((a) => a.join(' ') === `tab close ${id}`));
});
test('working predecessor at zero wait remains open and reports timeout', (t) => {
  const x = setup(t, {
    KRN_PREDECESSOR_PANE: 'pred',
    KRN_PREDECESSOR_SESSION: 'session',
    AGENTS: JSON.stringify({ pred: [agent('working')] }),
  });
  let stderr = '';
  const old = process.stderr.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderr += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(retire(['--wait-seconds', '0']), 0);
  } finally {
    process.stderr.write = old;
  }
  assert.match(stderr, /predecessor still working/u);
  assert.ok(!calls(x.calls).some((a) => a[1] === 'close'));
});
test('predecessor becoming idle on second poll closes', (t) => {
  const x = setup(t, {
    KRN_PREDECESSOR_PANE: 'pred',
    KRN_PREDECESSOR_SESSION: 'session',
    AGENTS: JSON.stringify({ pred: [agent('working'), agent('idle')] }),
  });
  let clock = 0;
  assert.equal(
    retire(
      ['--wait-seconds', '5'],
      (seconds) => {
        clock += seconds * 1000;
      },
      () => clock,
    ),
    0,
  );
  assert.equal(calls(x.calls).filter((a) => a[0] === 'agent').length, 2);
  assert.ok(calls(x.calls).some((a) => a.join(' ') === 'pane close pred'));
});
test('different predecessor session is not closed', (t) => {
  const x = setup(t, {
    KRN_PREDECESSOR_PANE: 'pred',
    KRN_PREDECESSOR_SESSION: 'expected',
    AGENTS: JSON.stringify({ pred: [agent('idle', 'other')] }),
  });
  retire(['--wait-seconds', '0']);
  assert.ok(!calls(x.calls).some((a) => a[1] === 'close'));
});
test('missing Herdr context makes no Herdr calls', (t) => {
  const x = setup(t);
  delete process.env.HERDR_PANE_ID;
  assert.equal(retire([]), 0);
  assert.deepEqual(calls(x.calls), []);
});
test('pane get failure is best effort and does not close tabs', (t) => {
  const x = setup(t, { FAIL_PANE: '1' });
  assert.equal(retire([]), 0);
  assert.ok(!calls(x.calls).some((a) => a.includes('close')));
});
test('wait bounds reject invalid values with usage status 64', (t) => {
  setup(t);
  assert.equal(retire(['--wait-seconds', '601']), 64);
  assert.equal(retire(['--wait-seconds', 'x']), 64);
});
test('failed predecessor close is reported on stderr and exits 0', (t) => {
  setup(t, {
    KRN_PREDECESSOR_PANE: 'pred',
    KRN_PREDECESSOR_SESSION: 'session',
    AGENTS: JSON.stringify({ pred: [agent('idle')] }),
    FAIL_CLOSE: '1',
  });
  let stderr = '';
  const old = process.stderr.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderr += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(retire(['--wait-seconds', '0']), 0);
  } finally {
    process.stderr.write = old;
  }
  assert.match(stderr, /retire: failed to close predecessor pred/u);
});
