import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { requiresIsolation } from '../helpers/isolation.ts';

test('SIGTERM during the pre-write activity read prevents the real ledger update', async (t) => {
  if (
    !requiresIsolation(
      t,
      'SIGTERM during the pre-write activity read prevents the real ledger update',
      ['bwrap', 'systemdUserScope'],
    )
  )
    return;
  const scratch = join(process.cwd(), '.krn', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'krn-stop-submit-'));
  const jobId = 'stop-before-paperclip-write';
  const issueId = 'I-STOP-WRITE';
  const activityEntered = join(root, 'activity-entered');
  const releaseActivity = join(root, 'release-activity');
  const updateCalls = join(root, 'update-calls');
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, '.gitignore'), '.krn/\n');
  await writeFile(join(root, 'README.md'), 'ledger abort fixture\n');
  await writeFile(
    join(root, 'krn.checks.json'),
    JSON.stringify({
      version: 1,
      checks: [{ id: 'gate', argv: ['/usr/bin/true'], timeoutMs: 3000 }],
    }),
  );
  git(['add', '.gitignore', 'README.md', 'krn.checks.json']);
  git(['commit', '-qm', 'test: initialize stop before write fixture']);
  git(['remote', 'add', 'origin', 'https://github.com/fixture/repo.git']);

  const childSource = `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    import { runJob } from ${JSON.stringify(new URL('../../src/foreman/run.ts', import.meta.url).href)};
    import { recordRepo } from ${JSON.stringify(new URL('../../src/foreman/state.ts', import.meta.url).href)};
    import { createLedger } from ${JSON.stringify(new URL('../../src/ledger/index.ts', import.meta.url).href)};
    import * as relay from ${JSON.stringify(new URL('../../src/relay/index.ts', import.meta.url).href)};
    import * as trace from ${JSON.stringify(new URL('../../src/trace/index.ts', import.meta.url).href)};
    const root=${JSON.stringify(root)}, jobId=${JSON.stringify(jobId)}, issueId=${JSON.stringify(issueId)};
    const job={id:jobId,issue:issueId,worktree:root,repoRoot:root};
    const revision='2026-10-08T10:00:00.000Z';
    const description='\\x60\\x60\\x60krn-contract\\n'+JSON.stringify({version:1,targetRepo:'fixture/repo',checks:['gate']})+'\\n\\x60\\x60\\x60';
    const makeIssue=(updatedAt=revision,status='in_progress')=>({id:issueId,identifier:issueId,title:'Fixture',description,updatedAt,status,assigneeAgentId:'fixture'});
    const controller=new AbortController();
    process.once('SIGTERM',()=>controller.abort('SIGTERM'));
    recordRepo(job,root);
    let firstActivity=true;
    const transport={
      readIssue:async()=>makeIssue(),
      readActivity:async()=>{
        if(firstActivity){
          firstActivity=false;
          writeFileSync(${JSON.stringify(activityEntered)},'entered');
          while(!existsSync(${JSON.stringify(releaseActivity)})) await new Promise((resolve)=>setTimeout(resolve,10));
        }
        return [];
      },
      readComments:async()=>[],
      updateIssue:async(_issue,status,comment)=>{
        appendFileSync(${JSON.stringify(updateCalls)},JSON.stringify({status,comment})+'\\n');
        return makeIssue('2026-10-08T11:00:00.000Z',status);
      },
    };
    const ledger=createLedger({session:'fixture-session',transport});
    const deps={
      budget:{maxResets:0,maxRepairs:0,session:{timeoutMs:1000}},
      signal:controller.signal,
      ledger,
      relay,
      trace:{
        ...trace,
        failure:async(_job,intent,error)=>writeFileSync(root+'/failure.txt',String(error?.stack??error)),
        hasCheckpoint:async()=>true,
        checkpointRequest:async()=>({message:'feat: commit stop fixture',next:'done'}),
        checkpoint:async()=>undefined,
        commit:async()=>undefined,
      },
      hosts:{
        codex:{
          start:async(input)=>{
            const id='fixture-session';
            if(!(await input.onStarted(id))) throw new Error('session bind failed');
            return {id,wait:async()=>{
              writeFileSync(root+'/worker-change.txt','commit me\\n');
              return {reasonKind:'exit',claimsDone:false};
            }};
          },
        },
        cancelTree:async()=>undefined,
      },
      stop:(_job,state,reasons)=>({kind:'stop',state,reasons}),
    };
    const outcome=await runJob(job,deps);
    if(controller.signal.aborted){await trace.stopped(job,'SIGTERM');process.exitCode=130;}
    process.stdout.write(JSON.stringify(outcome)+'\\n');
  `;

  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', childSource],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  try {
    const deadline = Date.now() + 15000;
    while (
      !existsSync(activityEntered) &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!existsSync(activityEntered)) {
      const eventsFile = join(
        root,
        '.krn',
        'runs',
        'foreman',
        jobId,
        'trace.jsonl',
      );
      const events = await readFile(eventsFile, 'utf8').catch(() => '');
      const failure = await readFile(join(root, 'failure.txt'), 'utf8').catch(
        () => '',
      );
      assert.fail(
        `ledger never reached the controlled pre-write activity read (exit=${child.exitCode}; stdout=${stdout}; stderr=${stderr}; trace=${events}; failure=${failure})`,
      );
    }
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(releaseActivity, 'release');
    const code = await new Promise<number | null>((resolve) =>
      child.once('close', resolve),
    );
    assert.equal(code, 130, stderr);
    assert.equal(
      existsSync(updateCalls),
      false,
      `ledger started a Paperclip update: ${stdout}`,
    );
    assert.match(stdout, /"kind":"stop"/u);
    const traceFile = join(
      root,
      '.krn',
      'runs',
      'foreman',
      jobId,
      'trace.jsonl',
    );
    const events = await readFile(traceFile, 'utf8');
    assert.match(events, /"kind":"stopped"/u);
    assert.doesNotMatch(events, /"kind":"paperclip_update_started"/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
