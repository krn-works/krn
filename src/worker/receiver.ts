import { homedir } from 'node:os';
import { resolveSupportedCodex } from '../hosts/codex.ts';
import { probeCodexAppServer } from '../hosts/codex-probe.ts';
import { WorkerError } from './state.ts';

/**
 * The Codex executable a worker may start: the newest installed release that
 * the start commit's spec/worker-scope.json supports, probed before any
 * systemd scope exists. Exit 65 names the supported versions otherwise.
 */
export function pickCodexReceiver(
  supported: readonly string[],
  repo: string,
  home: string = homedir(),
): string {
  const versions = supported.join(', ');
  const chosen = resolveSupportedCodex(supported, home);
  if (!chosen)
    throw new WorkerError(
      65,
      `no installed Codex release is supported; spec/worker-scope.json supports ${versions}`,
    );
  const probe = probeCodexAppServer(chosen.executable, repo);
  if ('error' in probe)
    throw new WorkerError(
      65,
      `Codex app-server probe failed for ${chosen.executable}: ${probe.error}`,
    );
  const accepted = chosen.version
    ? probe.version === chosen.version
    : supported.includes(probe.version);
  if (!accepted)
    throw new WorkerError(
      65,
      `Codex app-server at ${chosen.executable} reports ${probe.version}; expected ${chosen.version ?? `one of ${versions}`}`,
    );
  return chosen.executable;
}
