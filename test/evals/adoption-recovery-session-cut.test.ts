import assert from 'node:assert/strict';
import test from 'node:test';
import { liveGate, recoveryScenario } from '../../evals/adoption/recovery.ts';
import { admitLanesOnAnyHost } from '../helpers/lane-host.ts';

admitLanesOnAnyHost();

// KRN-12: the real drain, lane run and ship deliver a scratch outside repository; only the GitHub
// API (a stand-in at the gh boundary writing squash merges into the bare origin), the App mint and
// the worker are stand-ins. The point kills the whole batch once; the reruns must merge each task once.
test('a batch cut mid worker session resumes to exactly one merge per task', async () => {
  const result = await recoveryScenario('a');
  assert.equal(result.pass, true, result.detail);
});

test('live mode stops on a doctor refusal with its exit and never reports a pass', () => {
  const gate = liveGate(() => ({
    text: 'FAIL app: GitHub App not installed on owner/repo',
    exitCode: 67,
  }));
  assert.equal(gate.exitCode, 67);
  assert.match(
    gate.line,
    /^BLOCKED live: doctor --unattended exit 67: FAIL app/u,
  );
  assert.equal(liveGate(() => ({ text: '', exitCode: 0 })).exitCode, 0);
});
