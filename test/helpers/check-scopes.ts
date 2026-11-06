import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Host reads behind populated krn-check scope discovery, replaceable in unit tests. */
export interface CheckScopeHost {
  /** `systemctl --user list-units --all --type=scope --output=json`, parsed. */
  readonly listScopes: () => unknown;
  /** The scope's ControlGroup property, or an empty string. */
  readonly controlGroup: (unit: string) => string;
  /** Contents of `<cgroup>/<file>` under the unified hierarchy. */
  readonly readCgroup: (cgroup: string, file: string) => string;
  /** NUL-separated `/proc/<pid>/cmdline`. */
  readonly cmdline: (pid: string) => string;
}

export function systemCheckScopeHost(env: NodeJS.ProcessEnv): CheckScopeHost {
  return {
    listScopes() {
      const listed = spawnSync(
        'systemctl',
        [
          '--user',
          'list-units',
          '--all',
          '--type=scope',
          '--no-pager',
          '--output=json',
        ],
        { encoding: 'utf8', env },
      );
      if (listed.status !== 0)
        throw new Error(`systemctl list-units failed: ${listed.stderr}`);
      return JSON.parse(listed.stdout);
    },
    controlGroup(unit) {
      return spawnSync(
        'systemctl',
        ['--user', 'show', unit, '--property=ControlGroup', '--value'],
        { encoding: 'utf8', env },
      ).stdout.trim();
    },
    readCgroup(cgroup, file) {
      return readFileSync(join('/sys/fs/cgroup', cgroup, file), 'utf8');
    },
    cmdline(pid) {
      return readFileSync(join('/proc', pid, 'cmdline'), 'utf8');
    },
  };
}

/**
 * Active, populated krn-check scopes. With `owner`, only scopes holding a
 * process whose command line contains `owner`: parallel test shards create
 * their own krn-check scopes, so a host-wide diff is not attributable.
 */
export function populatedCheckScopes(
  host: CheckScopeHost,
  owner?: string,
): Set<string> {
  const scopes = host.listScopes();
  if (!Array.isArray(scopes)) throw new Error('scope listing is not an array');
  const populated = new Set<string>();
  for (const scope of scopes) {
    if (
      typeof scope?.unit !== 'string' ||
      !scope.unit.startsWith('krn-check-') ||
      scope.active !== 'active'
    )
      continue;
    const cgroup = host.controlGroup(scope.unit);
    if (!cgroup.startsWith('/')) continue;
    try {
      if (!/^populated 1$/mu.test(host.readCgroup(cgroup, 'cgroup.events')))
        continue;
      if (owner === undefined) {
        populated.add(scope.unit);
        continue;
      }
      const pids = host.readCgroup(cgroup, 'cgroup.procs').split(/\s+/u);
      for (const pid of pids) {
        if (!/^\d+$/u.test(pid)) continue;
        try {
          if (host.cmdline(pid).includes(owner)) {
            populated.add(scope.unit);
            break;
          }
        } catch {}
      }
    } catch {}
  }
  return populated;
}
