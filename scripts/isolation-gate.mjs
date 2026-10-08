export function decideIsolation(testName, required, capabilities, isCI) {
  const labels = {
    bwrap: 'bwrap user namespaces',
    systemdUserScope: 'systemd user scopes',
  };
  const missing = required.filter((name) => !capabilities[name]?.available);
  if (missing.length === 0) return { kind: 'run' };

  const list = missing.map((name) => labels[name]).join(', ');
  if (isCI)
    return {
      kind: 'skip',
      line: `SKIP(isolation): ${testName} — missing ${list}`,
    };
  return {
    kind: 'fail',
    message: `Isolation requirements failed for ${testName}: missing ${list}`,
  };
}

export function isolationSummary(skipCount) {
  return `Isolation-dependent tests skipped: ${skipCount}`;
}

export function countIsolationSkips(output) {
  return (output.match(/SKIP\(isolation\):/gu) ?? []).length;
}

export function testSuiteExitCode(exitCode, skipCount, requireZeroSkips) {
  if (exitCode !== 0) return exitCode || 1;
  return requireZeroSkips && skipCount > 0 ? 1 : 0;
}

export async function postGateStatusWhenClean({ exitCode, skipCount, post }) {
  if (exitCode !== 0 || skipCount !== 0) return false;
  await post();
  return true;
}
